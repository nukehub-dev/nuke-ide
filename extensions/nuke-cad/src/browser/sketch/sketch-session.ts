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
    type SketchPrimitive as SolverSketchPrimitive,
    type SketchPoint,
    type SketchLine,
    type SketchCircle,
    type SketchArc,
    type SketchEllipse,
    type TemporaryConstraint,
    type SolverResult,
    type SolverDiagnostic,
    buildSolverDiagnostics
} from '../../common/sketch-solver';
import {
    NUKE_CAD_SCHEMA_VERSION,
    type SketchDef,
    type NukeCadDocument,
    validateNukeCadDocument,
    type SketchDimension,
    type DimensionKind
} from '../../common/cad-document';
import { snap, createSnapConfig, type Point2, type SnapConfig, type SnapResult } from './snap';
import {
    lineLineIntersection,
    lineCircleIntersections,
    circleCircleIntersections,
    segmentParameter,
    projectPointOntoSegment,
    pointToSegmentDistance,
    angleOfPoint,
    arcPointAt,
    isAngleOnArc,
    translatePoint,
    rotatePoint,
    scalePoint,
    mirrorPointAcrossLine,
    axisAngle,
    rotateAngle,
    mirrorAngle,
    offsetLinePoints
} from './sketch-math';
import { clampedUniformKnots, sharedEllipsePolyline, sharedBSplinePolyline, nearestPolylinePoint } from '../../common/sketch-curves';
import { type TopologyRef } from '../../common/topology-refs';

function clonePoint3(p: import('../../common/topology-refs').Point3): import('../../common/topology-refs').Point3 {
    return [p[0], p[1], p[2]];
}

function cloneTopologyRef(ref: TopologyRef): TopologyRef {
    const base = {
        featureId: ref.featureId,
        kind: ref.kind
    };
    if (ref.kind === 'edge') {
        const edge = ref.fingerprint as import('../../common/topology-refs').EdgeFingerprint;
        const cloned: import('../../common/topology-refs').EdgeFingerprint = {
            curveType: edge.curveType,
            length: edge.length,
            start: clonePoint3(edge.start),
            end: clonePoint3(edge.end)
        };
        if (edge.center !== undefined) {
            cloned.center = clonePoint3(edge.center);
        }
        return { ...base, fingerprint: cloned };
    }
    const face = ref.fingerprint as import('../../common/topology-refs').FaceFingerprint;
    const cloned: import('../../common/topology-refs').FaceFingerprint = {
        surfaceType: face.surfaceType,
        area: face.area,
        center: clonePoint3(face.center)
    };
    if (face.normal !== undefined) {
        cloned.normal = clonePoint3(face.normal);
    }
    if (face.axis !== undefined) {
        cloned.axis = {
            origin: clonePoint3(face.axis.origin),
            direction: clonePoint3(face.axis.direction)
        };
    }
    if (face.radius !== undefined) {
        cloned.radius = face.radius;
    }
    if (face.minorRadius !== undefined) {
        cloned.minorRadius = face.minorRadius;
    }
    return { ...base, fingerprint: cloned };
}

/** Sketch primitive as exposed by the session, including the construction flag. */
export type SketchPrimitive = SolverSketchPrimitive & { construction: boolean };

/** Tools supported by the sketch session. */
export type SketchTool =
    | 'select'
    | 'point'
    | 'line'
    | 'circle'
    | 'arc3'
    | 'rectangle'
    | 'slot'
    | 'ellipse'
    | 'bspline'
    | 'trim'
    | 'extend'
    | 'split'
    | 'sketchFillet'
    | 'sketchChamfer'
    | 'polyline'
    | 'polygon'
    | 'arcSlot'
    | 'move'
    | 'copy'
    | 'rotate'
    | 'mirrorTool';

/**
 * Single-key tool shortcuts routed by the CAD viewport while a sketch session
 * is active and the viewport holds focus. Keys avoid the reserved bindings
 * (Delete/Backspace/Escape/Tab, the 3D-only F/., and Q for the shortcut bar)
 * plus M, which cycles the rectangle/polyline/polygon mode of the active tool
 * via {@link SketchSession.cycleMode} instead of switching tools.
 */
export const SKETCH_TOOL_SHORTCUTS: Readonly<Record<string, SketchTool>> = {
    s: 'select',
    l: 'line',
    c: 'circle',
    a: 'arc3',
    r: 'rectangle',
    o: 'slot',
    p: 'point',
    e: 'ellipse',
    b: 'bspline',
    t: 'trim',
    x: 'extend',
    d: 'split',
    j: 'sketchFillet',
    k: 'sketchChamfer',
    w: 'polyline',
    y: 'polygon',
    u: 'arcSlot',
    v: 'move',
    g: 'copy',
    i: 'rotate',
    n: 'mirrorTool'
};

/** Rectangle construction modes, cycled with M while the rectangle tool is active. */
export type RectangleMode = 'corner' | 'center' | 'rounded';

/** Polyline segment modes, cycled with M while the polyline tool is active. */
export type PolylineMode = 'line' | 'arc';

/** Minimum/maximum polygon side counts; M wraps the side count through this range. */
export const POLYGON_MIN_SIDES = 3;
export const POLYGON_MAX_SIDES = 12;
/** Default polygon side count. */
export const POLYGON_DEFAULT_SIDES = 6;
/** Rounded-rectangle fillet radius as a fraction of the shorter edge. */
export const ROUNDED_RECTANGLE_RADIUS_RATIO = 0.2;

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
    /** When true a radius constraint becomes a diameter constraint. */
    diameter?: boolean;
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
    /**
     * Caller-assigned ids of partially-redundant constraints (GCS QR-rank
     * analysis: consistent now, may turn conflicting after later edits).
     */
    partiallyRedundant?: string[];
    /**
     * Human-readable solver/validator diagnostics (one entry per tag group
     * plus validator findings). Rendered by the Solver Diagnostics popover.
     */
    diagnostics?: SolverDiagnostic[];
    /** True when the sketch has zero remaining DOF and no conflicts. */
    fullyConstrained: boolean;
    /** Auto-constraints produced by the last user action. */
    lastAutoConstraints: AutoConstraintFeedback[];
    /**
     * Transient user-facing hint (for example invalid gesture input such as
     * equal ellipse radii); cleared by the next user action.
     */
    hint?: string;
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
    /** True when the radius constraint is actually a diameter constraint. */
    diameter?: boolean;
}

/** Preview geometry returned by hover() for the current tool and in-progress state. */
export type SketchPreview =
    | { type: 'none' }
    | { type: 'point'; point: Point2 }
    | { type: 'line'; p1: Point2; p2: Point2 }
    | { type: 'circle'; center: Point2; radius: number }
    | { type: 'arc'; center: Point2; radius: number; startAngle: number; endAngle: number }
    | { type: 'rectangle'; p1: Point2; p2: Point2 }
    | { type: 'ellipse'; center: Point2; focus1: Point2; radmin: number }
    | { type: 'bspline'; poles: Point2[] };

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
    /**
     * Document-level parameters inherited by this sketch.
     *
     * Inherited parameters are registered in the solver so dimensions can bind
     * to them, but they are excluded from {@link SketchSession.toSketchDef} so
     * the persisted sketch-local parameter table only contains parameters
     * created inside the sketch session.
     */
    inheritedParameters?: Record<string, number>;
}

/** Listener invoked after any mutation that changes the sketch state. */
export type ChangeListener = () => void;

/** Result of {@link SketchSession.addConstraint}. */
export interface AddConstraintResult {
    success: boolean;
    constraintId?: string;
    dimensionId?: string;
    error?: string;
}

/** Result of {@link SketchSession.addDimension}. */
export interface AddDimensionResult {
    success: boolean;
    dimensionId?: string;
    constraintId?: string;
    error?: string;
}

/** A point pair that nearly coincides without a coincident constraint. */
export interface MissingCoincident {
    p1Id: string;
    p2Id: string;
    distance: number;
}

/** An open wire end: a vertex used by exactly one sketch segment. */
export interface OpenVertex {
    pointId: string;
    segmentIds: string[];
}

/** Result of {@link SketchSession.blockPrimitives}. */
export interface BlockResult {
    success: boolean;
    error?: string;
    constraintIds?: string[];
}

/** Result of {@link SketchSession.carbonCopyFrom}. */
export interface CarbonCopyResult {
    /** Fresh primitive ids added to this session, in copy order (points first). */
    addedPrimitiveIds: string[];
    /** Human-readable error when the copy was rejected or failed. */
    error?: string;
}

/** Result of {@link SketchSession.exposeEllipseInternals}. */
export interface ExposeEllipseInternalsResult {
    success: boolean;
    error?: string;
    /** Fresh id of the mirrored second-focus construction point. */
    focus2Id?: string;
    /** Fresh id of the major-axis construction line (focus1 to focus2). */
    majorAxisLineId?: string;
    /** Fresh id of the minor-axis construction line (through the center). */
    minorAxisLineId?: string;
}

/** Result of {@link SketchSession.filletCorner}. */
export interface FilletResult {
    success: boolean;
    error?: string;
    arcId?: string;
    dimensionId?: string;
    constraintId?: string;
}

/** Result of {@link SketchSession.chamferCorner}. */
export interface ChamferResult {
    success: boolean;
    error?: string;
    lineId?: string;
}

/** Result of the single-click curve edit operations (trim/extend/split). */
export interface EditCurveResult {
    success: boolean;
    error?: string;
    /** Id of the curve that was edited. */
    targetId?: string;
    /** Primary new/edited point (moved end, split point, trim anchor), when applicable. */
    pointId?: string;
    /** Curve ids produced by the edit (split halves, replacement arcs), when applicable. */
    newIds?: string[];
}

/** Result of selection-transform operations (move/copy/rotate/mirror/scale/array/offset). */
export interface TransformResult {
    success: boolean;
    error?: string;
    /** Fresh primitive ids added by the operation (copies, array instances, offset survivors). */
    addedPrimitiveIds?: string[];
    /** Primitive ids modified in place (move/rotate/scale/offset targets). */
    movedPrimitiveIds?: string[];
}

/** Result of {@link SketchSession.joinOpenEnds}. */
export interface JoinResult {
    success: boolean;
    error?: string;
    /** Id of the connecting line, when the join succeeded. */
    lineId?: string;
}

/** Options for {@link SketchSession.editDimension}. */
export interface EditDimensionOptions {
    /** New literal value; ignored when parameter is set. */
    value?: number;
    /** New parameter name to bind; pass an empty string to unbind. */
    parameter?: string;
    /** Toggle driving (true) vs reference (false). */
    driving?: boolean;
}

/** Result of dimension edit operations. */
export interface EditDimensionResult {
    success: boolean;
    error?: string;
}

/** Result of parameter CRUD operations. */
export interface ParameterResult {
    success: boolean;
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

interface InProgressSlot {
    tool: 'slot';
    stage: 1 | 2;
    c1Id: string;
    c1: Point2;
    c2Id?: string;
    c2?: Point2;
}

interface InProgressEllipse {
    tool: 'ellipse';
    stage: 1 | 2 | 3;
    centerId: string;
    center: Point2;
    majorId?: string;
    major?: Point2;
}

interface InProgressBSpline {
    tool: 'bspline';
    poleIds: string[];
    poles: Point2[];
}

interface InProgressSketchFillet {
    tool: 'sketchFillet';
    stage: 1 | 2;
    lineAId: string;
    lineBId?: string;
}

interface InProgressSketchChamfer {
    tool: 'sketchChamfer';
    stage: 1 | 2;
    lineAId: string;
    lineBId?: string;
}

interface InProgressPolyline {
    tool: 'polyline';
    lastId: string;
    last: Point2;
    segmentIds: string[];
    arcMidId?: string;
    arcMid?: Point2;
}

interface InProgressPolygon {
    tool: 'polygon';
    stage: 1;
    centerId: string;
    center: Point2;
}

interface InProgressArcSlot {
    tool: 'arcSlot';
    stage: 1 | 2 | 3;
    centerId: string;
    center: Point2;
    startId?: string;
    start?: Point2;
    endId?: string;
    end?: Point2;
}

interface InProgressMove {
    tool: 'move';
    stage: 1;
    base: Point2;
}

interface InProgressCopy {
    tool: 'copy';
    stage: 1;
    base: Point2;
}

interface InProgressRotate {
    tool: 'rotate';
    stage: 1;
    center: Point2;
}

type InProgressState =
    | InProgressLine
    | InProgressCircle
    | InProgressArc3
    | InProgressRectangle
    | InProgressSlot
    | InProgressEllipse
    | InProgressBSpline
    | InProgressSketchFillet
    | InProgressSketchChamfer
    | InProgressPolyline
    | InProgressPolygon
    | InProgressArcSlot
    | InProgressMove
    | InProgressCopy
    | InProgressRotate;

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

function validateParameterValue(value: number, name: string): string | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return `Parameter '${name}' must be a finite number, got ${value}`;
    }
    return undefined;
}

/**
 * Planegcs constraint fields that reference sketch primitives, including the
 * camelCase aliases accepted on load. Used to remap endpoint ids when a
 * sketch is carbon-copied into another session.
 */
const CARBON_COPY_PRIMITIVE_ID_FIELDS: ReadonlySet<string> = new Set([
    'p1_id',
    'p2_id',
    'p_id',
    'l_id',
    'l1_id',
    'l2_id',
    'c_id',
    'c1_id',
    'c2_id',
    'a_id',
    'a1_id',
    'a2_id',
    'p1Id',
    'p2Id',
    'pId',
    'lId',
    'l1Id',
    'l2Id',
    'cId',
    'c1Id',
    'c2Id',
    'aId',
    'a1Id',
    'a2Id'
]);

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

/** Curve kinds the trim/extend/split tools can target (never ellipses or B-splines). */
const TRIM_CURVE_TARGETS: ReadonlySet<'line' | 'circle' | 'arc'> = new Set(['line', 'circle', 'arc']);

/** Curve kinds the sketch fillet/chamfer staging picks accept. */
const LINE_TARGET: ReadonlySet<'line' | 'circle' | 'arc'> = new Set(['line']);

/** An intersection of the edited curve with a cutting curve. */
interface CurveIntersection {
    point: Point2;
    otherId: string;
}

/**
 * Sketch session controller.
 *
 * Create with {@link SketchSession.create} or restore with {@link SketchSession.fromSketchDef}.
 */
export class SketchSession {
    /** Default snap search radius in screen pixels (the viewport's historical value). */
    static readonly DEFAULT_SNAP_RADIUS_PX = 12;

    private readonly solver: SketchSolver;
    private readonly id: string;
    private name: string;
    private datumId: string;
    private readonly snapConfig: SnapConfig;
    private readonly autoConstraintAngleThresholdDeg: number;
    private snapEnabled = true;
    private snapRadiusPx = SketchSession.DEFAULT_SNAP_RADIUS_PX;

    private readonly primitives = new Map<string, SketchPrimitive & PrimitiveMeta>();
    private readonly constraints = new Map<string, ConstraintRecord>();
    private readonly fixConstraintIds = new Map<string, string>(); // pointId -> constraintId
    private readonly parameters = new Map<string, number>();
    private readonly inheritedParameterNames = new Set<string>();
    private readonly dimensions = new Map<string, SketchDimension>();
    private readonly externalRefs: TopologyRef[] = [];

    private tool: SketchTool = 'select';
    private readonly selectedIds = new Set<string>();
    private inProgress: InProgressState | undefined;
    private rectangleMode: RectangleMode = 'corner';
    private polylineMode: PolylineMode = 'line';
    private polygonSides = POLYGON_DEFAULT_SIDES;
    private drag: DragState | undefined;
    private status: SketchStatus;
    private readonly listeners = new Set<ChangeListener>();
    private idCounter = 0;
    private carbonCopyCount = 0;

    private constructor(solver: SketchSolver, options: SketchSessionOptions = {}) {
        this.solver = solver;
        this.id = options.id ?? this.nextId('sketch');
        this.name = options.name ?? 'Sketch';
        this.datumId = options.datumId ?? 'xy';
        this.snapConfig = createSnapConfig(options.snap);
        this.autoConstraintAngleThresholdDeg = options.autoConstraintAngleThresholdDeg ?? 5;
        for (const [name, value] of Object.entries(options.inheritedParameters ?? {})) {
            this.addParameterInternal(name, value);
            this.inheritedParameterNames.add(name);
        }
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
     *
     * @param options - Additional session options. ``inheritedParameters`` are
     *   seeded after sketch-local parameters so document-level parameters take
     *   precedence when names collide.
     */
    static async fromSketchDef(
        def: SketchDef,
        solver: SketchSolver,
        options?: Omit<SketchSessionOptions, 'id' | 'name' | 'datumId'>
    ): Promise<SketchSession> {
        const session = new SketchSession(solver, {
            id: def.id,
            name: def.name,
            datumId: def.datumId,
            snap: options?.snap,
            autoConstraintAngleThresholdDeg: options?.autoConstraintAngleThresholdDeg
        });

        // Register parameters first so constraints can reference them.
        for (const [name, value] of Object.entries(def.parameters ?? {})) {
            session.addParameterInternal(name, value);
        }

        // Seed inherited document parameters after sketch-local ones. Document
        // parameters take precedence when names collide, consistent with the
        // document being the source of truth for named values.
        for (const [name, value] of Object.entries(options?.inheritedParameters ?? {})) {
            if (session.parameters.has(name)) {
                session.parameters.set(name, value);
                session.solver.setParameter(name, value);
            } else {
                session.addParameterInternal(name, value);
            }
            session.inheritedParameterNames.add(name);
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
            } else if (raw.type === 'ellipse') {
                session.addEllipseInternal(
                    id,
                    String(raw.c_id ?? raw.centerId),
                    String(raw.focus1_id ?? raw.focus1Id),
                    Number(raw.radmin),
                    Boolean(raw.construction)
                );
            } else if (raw.type === 'bspline') {
                const poleIds = (raw.pole_ids ?? raw.poleIds ?? []) as unknown[];
                const weights = (raw.weights ?? []) as unknown[];
                const knots = (raw.knots ?? []) as unknown[];
                const mult = (raw.mult ?? []) as unknown[];
                session.addBSplineInternal(
                    id,
                    poleIds.map(String),
                    weights.map(Number),
                    knots.map(Number),
                    mult.map(Number),
                    Number(raw.degree),
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

        // Restore dimension metadata after constraints are loaded so constraintId
        // references are valid.
        for (const raw of def.dimensions ?? []) {
            const dimension = raw as SketchDimension;
            const numericValue =
                typeof dimension.value === 'number' && Number.isFinite(dimension.value)
                    ? dimension.value
                    : session.resolveParameterValue(dimension.parameter ?? dimension.value);
            session.dimensions.set(dimension.id, {
                id: dimension.id,
                constraintId: dimension.constraintId,
                kind: dimension.kind,
                targetIds: [...dimension.targetIds],
                driving: dimension.driving,
                parameter: dimension.parameter,
                value: numericValue,
                labelOffset: dimension.labelOffset
            });
        }

        // Restore external geometry references.
        if (def.externalRefs !== undefined) {
            for (const ref of def.externalRefs) {
                session.externalRefs.push(cloneTopologyRef(ref));
            }
        }

        await session.solve();
        return session;
    }

    /** Release the solver and clear session state. */
    destroy(): void {
        this.listeners.clear();
        this.solver.destroy();
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

    /** True when pointer snapping is enabled for this session. */
    isSnapEnabled(): boolean {
        return this.snapEnabled;
    }

    /** Enable or disable snapping; disabled means free pointer placement. */
    setSnapEnabled(on: boolean): void {
        if (this.snapEnabled === on) {
            return;
        }
        this.snapEnabled = on;
        this.emitChange();
    }

    /** Current snap search radius in screen pixels. */
    getSnapRadiusPx(): number {
        return this.snapRadiusPx;
    }

    /**
     * Set the snap search radius in screen pixels.
     *
     * The model-space snap reach scales proportionally to
     * {@link DEFAULT_SNAP_RADIUS_PX}, so larger values grab nearby geometry
     * from farther away.
     */
    setSnapRadius(px: number): void {
        finite(px, 'Snap radius');
        if (px <= 0) {
            throw new Error(`Snap radius must be positive, got ${px}`);
        }
        if (this.snapRadiusPx === px) {
            return;
        }
        this.snapRadiusPx = px;
        this.emitChange();
    }

    /** Current tool. */
    getTool(): SketchTool {
        return this.tool;
    }

    /** Current rectangle construction mode (M cycles corner/center/rounded). */
    getRectangleMode(): RectangleMode {
        return this.rectangleMode;
    }

    /** Current polyline segment mode (M cycles line/arc). */
    getPolylineMode(): PolylineMode {
        return this.polylineMode;
    }

    /** Current polygon side count (M wraps 3-12). */
    getPolygonSides(): number {
        return this.polygonSides;
    }

    /**
     * Cycle the mode of the active tool (M key semantics).
     *
     * Rectangle cycles corner/center/rounded, polyline toggles line/arc
     * (dropping a staged arc midpoint), and polygon wraps the side count
     * 3-12. Other tools are unaffected. The new mode is reported through the
     * transient `SketchStatus.hint` status line.
     */
    cycleMode(): void {
        if (this.tool === 'rectangle') {
            this.rectangleMode = this.rectangleMode === 'corner' ? 'center' : this.rectangleMode === 'center' ? 'rounded' : 'corner';
            this.status = { ...this.status, hint: `Rectangle mode: ${this.rectangleMode}` };
            this.emitChange();
        } else if (this.tool === 'polyline') {
            this.polylineMode = this.polylineMode === 'line' ? 'arc' : 'line';
            if (this.inProgress !== undefined && this.inProgress.tool === 'polyline' && this.inProgress.arcMidId !== undefined) {
                this.removePrimitiveAndConstraints(this.inProgress.arcMidId);
                this.inProgress = { ...this.inProgress, arcMidId: undefined, arcMid: undefined };
            }
            this.status = { ...this.status, hint: `Polyline mode: ${this.polylineMode}` };
            this.emitChange();
        } else if (this.tool === 'polygon') {
            this.polygonSides = this.polygonSides >= POLYGON_MAX_SIDES ? POLYGON_MIN_SIDES : this.polygonSides + 1;
            this.status = { ...this.status, hint: `Polygon sides: ${this.polygonSides}` };
            this.emitChange();
        }
    }

    /** True while an entity is mid-placement (Esc's first escape hatch). */
    isInProgress(): boolean {
        return this.inProgress !== undefined;
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

    /** All committed dimensions. */
    getDimensions(): SketchDimension[] {
        return [...this.dimensions.values()];
    }

    /** All external geometry references attached to this sketch. */
    getExternalRefs(): readonly TopologyRef[] {
        return this.externalRefs;
    }

    /** Add an external geometry reference to this sketch. */
    addExternalRef(ref: TopologyRef): void {
        this.externalRefs.push(cloneTopologyRef(ref));
        this.emitChange();
    }

    /** Remove an external geometry reference by index. */
    removeExternalRef(index: number): boolean {
        if (index < 0 || index >= this.externalRefs.length) {
            return false;
        }
        this.externalRefs.splice(index, 1);
        this.emitChange();
        return true;
    }

    /** Read a single dimension by id. */
    getDimension(id: string): SketchDimension | undefined {
        return this.dimensions.get(id);
    }

    /**
     * Sketch-local parameter values.
     *
     * Excludes parameters inherited from the document; those are owned by the
     * document store and surfaced through {@link getAllParameters}.
     */
    getParameters(): Record<string, number> {
        const result: Record<string, number> = {};
        for (const [name, value] of this.parameters) {
            if (!this.inheritedParameterNames.has(name)) {
                result[name] = value;
            }
        }
        return result;
    }

    /** All parameters visible in the sketch, including inherited document ones. */
    getAllParameters(): Record<string, number> {
        const result: Record<string, number> = {};
        for (const [name, value] of this.parameters) {
            result[name] = value;
        }
        return result;
    }

    /** Names of parameters inherited from the document. */
    getInheritedParameterNames(): string[] {
        return [...this.inheritedParameterNames];
    }

    /** Define or update a sketch-local parameter. */
    async setParameter(name: string, value: number): Promise<ParameterResult> {
        const error = validateParameterValue(value, name);
        if (error !== undefined) {
            return { success: false, error };
        }
        this.parameters.set(name, value);
        this.solver.setParameter(name, value);
        await this.solveAndNotify();
        return { success: true };
    }

    /** Alias for {@link setParameter}. */
    addParameter(name: string, value: number): Promise<ParameterResult> {
        return this.setParameter(name, value);
    }

    private addParameterInternal(name: string, value: number): void {
        this.parameters.set(name, value);
        this.solver.addParameter(name, value);
    }

    /** Remove a sketch-local parameter. Rejects when a driving dimension is bound to it. */
    removeParameter(name: string): ParameterResult {
        const dependents: string[] = [];
        for (const dimension of this.dimensions.values()) {
            if (dimension.parameter === name && dimension.driving) {
                dependents.push(dimension.id);
            }
        }
        if (dependents.length > 0) {
            return {
                success: false,
                error: `Cannot remove parameter '${name}' because it is driving dimension(s): ${dependents.join(', ')}`
            };
        }
        for (const dimension of this.dimensions.values()) {
            if (dimension.parameter === name) {
                dimension.parameter = undefined;
            }
        }
        this.parameters.delete(name);
        this.solver.removeParameter(name);
        this.solveAndNotify();
        return { success: true };
    }

    /** Switch the active tool. Any in-progress entity is cancelled. */
    setTool(tool: SketchTool): void {
        this.cancel();
        this.tool = tool;
        this.status = { ...this.status, lastAutoConstraints: [] };
        this.emitChange();
    }

    /**
     * Set the session selection driving the selection-transform tools.
     *
     * The viewport owns click selection while the Select tool is active; it
     * publishes the ids here before the user switches to move/copy/rotate/
     * mirrorTool, and the inline popovers read it for joinEnds. Unknown ids
     * are kept as-is so the transform entry points can report them clearly.
     */
    setSelection(ids: string[]): void {
        this.selectedIds.clear();
        for (const id of ids) {
            this.selectedIds.add(id);
        }
        this.emitChange();
    }

    /** Ids currently driving the selection-transform tools. */
    getSelection(): string[] {
        return [...this.selectedIds];
    }

    /** Clear the session selection. */
    clearSelection(): void {
        if (this.selectedIds.size === 0) {
            return;
        }
        this.selectedIds.clear();
        this.emitChange();
    }

    /** Cancel the in-progress entity (Esc semantics). */
    cancel(): void {
        if (this.inProgress === undefined) {
            this.status = { ...this.status, lastAutoConstraints: [] };
            return;
        }
        if (this.inProgress.tool === 'polyline') {
            // Committed chain segments survive: Esc drops a staged arc
            // midpoint when one exists, otherwise it just ends the chain.
            this.clearInProgressPoints();
            if (this.inProgress.tool === 'polyline' && this.inProgress.arcMidId !== undefined) {
                this.inProgress = { ...this.inProgress, arcMidId: undefined, arcMid: undefined };
            } else {
                this.inProgress = undefined;
            }
            this.status = { ...this.status, lastAutoConstraints: [] };
            this.emitChange();
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
        } else if (this.inProgress.tool === 'slot') {
            ids.push(this.inProgress.c1Id);
            if (this.inProgress.c2Id !== undefined) {
                ids.push(this.inProgress.c2Id);
            }
        } else if (this.inProgress.tool === 'ellipse') {
            ids.push(this.inProgress.centerId);
            if (this.inProgress.majorId !== undefined) {
                ids.push(this.inProgress.majorId);
            }
        } else if (this.inProgress.tool === 'bspline') {
            ids.push(...this.inProgress.poleIds);
        } else if (this.inProgress.tool === 'sketchFillet' || this.inProgress.tool === 'sketchChamfer') {
            // Staged line picks create no geometry; nothing to delete.
        } else if (this.inProgress.tool === 'polyline') {
            // Polyline segments commit per click, so a full cancel only drops
            // a staged arc midpoint; the chain itself is handled by cancel().
            if (this.inProgress.arcMidId !== undefined) {
                ids.push(this.inProgress.arcMidId);
            }
        } else if (this.inProgress.tool === 'polygon') {
            ids.push(this.inProgress.centerId);
        } else if (this.inProgress.tool === 'arcSlot') {
            ids.push(this.inProgress.centerId);
            if (this.inProgress.startId !== undefined) {
                ids.push(this.inProgress.startId);
            }
            if (this.inProgress.endId !== undefined) {
                ids.push(this.inProgress.endId);
            }
        } else if (this.inProgress.tool === 'move' || this.inProgress.tool === 'copy' || this.inProgress.tool === 'rotate') {
            // Transform gestures stage raw clicks only; no primitives to delete.
        }
        for (const id of ids) {
            this.removePrimitiveAndConstraints(id);
        }
    }

    /**
     * Commit the current in-progress entity if applicable.
     *
     * All closed-form tools finish automatically on their final click; the
     * B-spline tool finishes here (Enter / double-click) once at least two
     * poles are placed, and the polyline tool finishes here by ending the
     * chain while keeping every committed segment. The method also resets the
     * last-action auto-constraint feedback.
     */
    async finish(): Promise<void> {
        if (this.inProgress !== undefined && this.inProgress.tool === 'bspline') {
            await this.commitBSpline(this.inProgress, []);
        } else if (this.inProgress !== undefined && this.inProgress.tool === 'polyline') {
            if (this.inProgress.arcMidId !== undefined) {
                this.removePrimitiveAndConstraints(this.inProgress.arcMidId);
            }
            this.inProgress = undefined;
            await this.commit([]);
            this.emitChange();
        }
        this.status = { ...this.status, lastAutoConstraints: [] };
    }

    /** Process a pointer click for the current tool. */
    async click(raw: Point2, modifiers?: { disableSnap?: boolean }): Promise<void> {
        const snapped = this.applySnap(raw, modifiers?.disableSnap);
        const auto: AutoConstraintFeedback[] = [];
        // A new action supersedes any transient gesture hint.
        this.status = { ...this.status, hint: undefined };

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
                    let center: Point2;
                    try {
                        center = circleCenterFromThreePoints(start, mid, end);
                    } catch {
                        auto.length = 0;
                        this.status = { ...this.status, lastAutoConstraints: [] };
                        this.emitChange();
                        return;
                    }
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
                } else if (this.rectangleMode === 'center') {
                    await this.commitCenterRectangle(this.inProgress, snapped, auto);
                } else if (this.rectangleMode === 'rounded') {
                    await this.commitRoundedRectangle(this.inProgress, snapped, auto);
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
            case 'slot': {
                if (this.inProgress === undefined || this.inProgress.tool !== 'slot') {
                    const c1Id = this.addPointForTool(snapped, auto);
                    this.inProgress = { tool: 'slot', stage: 1, c1Id, c1: snapped.point };
                    this.status = { ...this.status, lastAutoConstraints: auto };
                    this.emitChange();
                } else if (this.inProgress.stage === 1) {
                    const c1 = this.inProgress.c1;
                    if (Math.hypot(snapped.point.x - c1.x, snapped.point.y - c1.y) < 1e-12) {
                        this.status = { ...this.status, lastAutoConstraints: [] };
                        this.emitChange();
                        return;
                    }
                    const c2Id = this.addPointForTool(snapped, auto);
                    this.inProgress = {
                        tool: 'slot',
                        stage: 2,
                        c1Id: this.inProgress.c1Id,
                        c1,
                        c2Id,
                        c2: snapped.point
                    };
                    this.status = { ...this.status, lastAutoConstraints: auto };
                    this.emitChange();
                } else {
                    const { c1, c2 } = this.inProgress;
                    if (c2 === undefined) {
                        return;
                    }
                    const width = snapped.point;
                    const error = this.buildSlot(this.inProgress.c1Id, c1, this.inProgress.c2Id!, c2, width, auto);
                    if (error !== undefined) {
                        this.status = { ...this.status, lastAutoConstraints: [], hint: error };
                        this.emitChange();
                        return;
                    }
                    this.inProgress = undefined;
                    await this.commit(auto);
                    this.emitChange();
                }
                break;
            }
            case 'ellipse': {
                if (this.inProgress === undefined || this.inProgress.tool !== 'ellipse') {
                    const centerId = this.addPointForTool(snapped, auto);
                    this.inProgress = { tool: 'ellipse', stage: 1, centerId, center: snapped.point };
                    this.status = { ...this.status, lastAutoConstraints: auto };
                    this.emitChange();
                } else if (this.inProgress.stage === 1) {
                    const center = this.inProgress.center;
                    if (Math.hypot(snapped.point.x - center.x, snapped.point.y - center.y) < 1e-9) {
                        this.status = { ...this.status, lastAutoConstraints: [] };
                        this.emitChange();
                        return;
                    }
                    const majorId = this.addPointForTool(snapped, auto);
                    this.inProgress = {
                        tool: 'ellipse',
                        stage: 2,
                        centerId: this.inProgress.centerId,
                        center,
                        majorId,
                        major: snapped.point
                    };
                    this.status = { ...this.status, lastAutoConstraints: auto };
                    this.emitChange();
                } else {
                    const { center, centerId, majorId, major } = this.inProgress;
                    if (majorId === undefined || major === undefined) {
                        return;
                    }
                    const majorRadius = Math.hypot(major.x - center.x, major.y - center.y);
                    // Minor radius: the pointer's perpendicular distance to the
                    // major-axis line.
                    const axisLength = Math.hypot(major.x - center.x, major.y - center.y);
                    const nx = -(major.y - center.y) / axisLength;
                    const ny = (major.x - center.x) / axisLength;
                    const minorRaw = Math.abs((snapped.point.x - center.x) * nx + (snapped.point.y - center.y) * ny) || 1e-9;
                    if (Math.abs(minorRaw - majorRadius) / majorRadius < 1e-6) {
                        // An equal-radius "ellipse" is a circle; keep the gesture
                        // alive and point the user at the right tool.
                        this.status = {
                            ...this.status,
                            lastAutoConstraints: [],
                            hint: 'Equal radii make a circle — use the Circle tool (C) instead'
                        };
                        this.emitChange();
                        return;
                    }
                    const clampedMinor = Math.min(Math.max(minorRaw, 1e-9), majorRadius * (1 - 1e-9));
                    const hint =
                        Math.abs(clampedMinor - minorRaw) > 1e-12 * Math.max(1, minorRaw)
                            ? 'Minor radius clamped below the major radius'
                            : undefined;
                    const focal = Math.sqrt(majorRadius * majorRadius - clampedMinor * clampedMinor);
                    const focus1 = {
                        x: center.x + ((major.x - center.x) / axisLength) * focal,
                        y: center.y + ((major.y - center.y) / axisLength) * focal
                    };
                    const focus1Id = this.nextId('point');
                    this.addPointInternal(focus1Id, focus1.x, focus1.y, false);
                    const ellipseId = this.nextId('ellipse');
                    this.addEllipseInternal(ellipseId, centerId, focus1Id, clampedMinor, false);
                    this.inProgress = undefined;
                    await this.commit(auto);
                    this.status = { ...this.status, hint };
                    this.emitChange();
                }
                break;
            }
            case 'bspline': {
                const point = snapped.point;
                if (this.inProgress === undefined || this.inProgress.tool !== 'bspline') {
                    const poleId = this.addPointForTool(snapped, auto);
                    this.inProgress = { tool: 'bspline', poleIds: [poleId], poles: [point] };
                    this.status = { ...this.status, lastAutoConstraints: auto };
                    this.emitChange();
                } else {
                    const last = this.inProgress.poles[this.inProgress.poles.length - 1];
                    if (Math.hypot(point.x - last.x, point.y - last.y) < 1e-12) {
                        this.status = { ...this.status, lastAutoConstraints: [] };
                        this.emitChange();
                        return;
                    }
                    const poleId = this.addPointForTool(snapped, auto);
                    this.inProgress = {
                        tool: 'bspline',
                        poleIds: [...this.inProgress.poleIds, poleId],
                        poles: [...this.inProgress.poles, point]
                    };
                    this.status = { ...this.status, lastAutoConstraints: auto };
                    this.emitChange();
                }
                break;
            }
            case 'trim': {
                const result = await this.trimAt(raw, modifiers);
                this.status = result.success
                    ? { ...this.status, lastAutoConstraints: [] }
                    : { ...this.status, lastAutoConstraints: [], hint: result.error };
                this.emitChange();
                break;
            }
            case 'extend': {
                const result = await this.extendAt(raw, modifiers);
                this.status = result.success
                    ? { ...this.status, lastAutoConstraints: [] }
                    : { ...this.status, lastAutoConstraints: [], hint: result.error };
                this.emitChange();
                break;
            }
            case 'split': {
                const result = await this.splitAt(raw, modifiers);
                this.status = result.success
                    ? { ...this.status, lastAutoConstraints: [] }
                    : { ...this.status, lastAutoConstraints: [], hint: result.error };
                this.emitChange();
                break;
            }
            case 'sketchFillet': {
                await this.clickSketchFillet(snapped, raw);
                break;
            }
            case 'sketchChamfer': {
                await this.clickSketchChamfer(snapped, raw);
                break;
            }
            case 'polyline': {
                await this.clickPolyline(snapped);
                break;
            }
            case 'polygon': {
                await this.clickPolygon(snapped);
                break;
            }
            case 'arcSlot': {
                await this.clickArcSlot(snapped);
                break;
            }
            case 'move': {
                await this.clickMove(snapped);
                break;
            }
            case 'copy': {
                await this.clickCopy(snapped);
                break;
            }
            case 'rotate': {
                await this.clickRotate(snapped);
                break;
            }
            case 'mirrorTool': {
                await this.clickMirrorTool(snapped, raw);
                break;
            }
        }
    }

    /** Finish a B-spline gesture: build the curve through the placed poles. */
    private async commitBSpline(state: InProgressBSpline, auto: AutoConstraintFeedback[]): Promise<void> {
        if (state.poleIds.length < 2) {
            // A lone pole is not a curve; drop it like a cancelled gesture.
            this.clearInProgressPoints();
            this.inProgress = undefined;
            this.status = { ...this.status, lastAutoConstraints: [] };
            this.emitChange();
            return;
        }
        const degree = Math.min(3, state.poleIds.length - 1);
        const { knots, mult } = clampedUniformKnots(state.poleIds.length, degree);
        const weights = state.poleIds.map(() => 1);
        const bsplineId = this.nextId('bspline');
        this.addBSplineInternal(bsplineId, state.poleIds, weights, knots, mult, degree, false);
        this.inProgress = undefined;
        await this.commit(auto);
        this.emitChange();
    }

    /**
     * Build a slot (two parallel lines joined by two semicircular arcs)
     * through the staged center points c1/c2 with the width measured from w.
     *
     * The arc centers reuse the staged points so the slot stays editable;
     * tangency plus equal-radii constraints keep the profile consistent.
     * Returns an error message when the gesture is degenerate, else undefined.
     */
    private buildSlot(c1Id: string, c1: Point2, c2Id: string, c2: Point2, w: Point2, auto: AutoConstraintFeedback[]): string | undefined {
        const ux = c2.x - c1.x;
        const uy = c2.y - c1.y;
        const length = Math.hypot(ux, uy);
        if (length < 1e-9) {
            return 'Slot centers must be distinct points';
        }
        const dx = ux / length;
        const dy = uy / length;
        const nx = -dy;
        const ny = dx;
        const radius = Math.abs((w.x - c1.x) * nx + (w.y - c1.y) * ny);
        if (radius < 1e-9) {
            return 'Slot width must be non-zero — pick a third point off the centerline';
        }

        const a = { x: c1.x + nx * radius, y: c1.y + ny * radius };
        const b = { x: c2.x + nx * radius, y: c2.y + ny * radius };
        const c = { x: c2.x - nx * radius, y: c2.y - ny * radius };
        const d = { x: c1.x - nx * radius, y: c1.y - ny * radius };
        const aId = this.nextId('point');
        const bId = this.nextId('point');
        const cId = this.nextId('point');
        const dId = this.nextId('point');
        this.addPointInternal(aId, a.x, a.y, false);
        this.addPointInternal(bId, b.x, b.y, false);
        this.addPointInternal(cId, c.x, c.y, false);
        this.addPointInternal(dId, d.x, d.y, false);

        const lineAB = this.nextId('line');
        const lineCD = this.nextId('line');
        this.addLineInternal(lineAB, aId, bId, false);
        this.addLineInternal(lineCD, cId, dId, false);

        // Outward bulge points pick the correct semicircle sweep.
        const out1 = { x: c1.x - dx * radius, y: c1.y - dy * radius };
        const out2 = { x: c2.x + dx * radius, y: c2.y + dy * radius };
        const angles1 = arcAnglesFromThreePoints(c1, d, out1, a);
        const angles2 = arcAnglesFromThreePoints(c2, b, out2, c);
        const arc1 = this.nextId('arc');
        const arc2 = this.nextId('arc');
        this.addArcInternal(arc1, c1Id, radius, angles1.startAngle, angles1.endAngle, dId, aId, false);
        this.addArcInternal(arc2, c2Id, radius, angles2.startAngle, angles2.endAngle, bId, cId, false);

        for (const [lineId, arcId] of [
            [lineAB, arc1],
            [lineAB, arc2],
            [lineCD, arc1],
            [lineCD, arc2]
        ] as Array<[string, string]>) {
            const tangentId = this.nextId('tangent');
            this.solver.addConstraintTangent(tangentId, lineId, arcId, { driving: true });
            this.constraints.set(tangentId, { id: tangentId, kind: 'tangent', targetIds: [lineId, arcId], driving: true });
            auto.push({ kind: 'tangent', ids: [tangentId] });
        }
        const equalId = this.nextId('equal');
        this.solver.addConstraintEqual(equalId, arc1, arc2, { driving: true });
        this.constraints.set(equalId, { id: equalId, kind: 'equal', targetIds: [arc1, arc2], driving: true });
        auto.push({ kind: 'equal', ids: [equalId] });

        this.addAxisAutoConstraint(lineAB, a, b, auto);
        this.addAxisAutoConstraint(lineCD, c, d, auto);
        return undefined;
    }

    /**
     * Commit a center-mode rectangle: the staged point is the center, the
     * click is one corner, and the opposite corner is mirrored through the
     * center. The staged center point is removed afterwards so only the four
     * corner points remain.
     */
    private async commitCenterRectangle(state: InProgressRectangle, snapped: SnapResult, auto: AutoConstraintFeedback[]): Promise<void> {
        const c = state.p1;
        const k = snapped.point;
        if (Math.abs(c.x - k.x) < 1e-12 || Math.abs(c.y - k.y) < 1e-12) {
            this.status = { ...this.status, lastAutoConstraints: [] };
            this.emitChange();
            return;
        }
        const mirror = { x: 2 * c.x - k.x, y: 2 * c.y - k.y };
        const cornerId = this.addPointForTool(snapped, auto);
        const mirrorId = this.nextId('point');
        this.addPointInternal(mirrorId, mirror.x, mirror.y, false);
        const lineIds = this.createRectangle(k, mirror, cornerId, mirrorId, auto);
        this.applyRectangleAxisAutos(lineIds, auto);
        this.removePrimitiveAndConstraints(state.p1Id);
        this.inProgress = undefined;
        await this.commit(auto);
        this.emitChange();
    }

    /**
     * Commit a rounded rectangle: a corner-mode rectangle whose four corners
     * each go through the {@link filletCorner} core with an automatic radius
     * of {@link ROUNDED_RECTANGLE_RADIUS_RATIO} times the shorter edge.
     */
    private async commitRoundedRectangle(state: InProgressRectangle, snapped: SnapResult, auto: AutoConstraintFeedback[]): Promise<void> {
        const p1 = state.p1;
        const p2 = snapped.point;
        if (Math.abs(p1.x - p2.x) < 1e-12 || Math.abs(p1.y - p2.y) < 1e-12) {
            this.status = { ...this.status, lastAutoConstraints: [] };
            this.emitChange();
            return;
        }
        const p1Id = state.p1Id;
        const p2Id = this.addPointForTool(snapped, auto);
        const lineIds = this.createRectangle(p1, p2, p1Id, p2Id, auto);
        const radius = ROUNDED_RECTANGLE_RADIUS_RATIO * Math.min(Math.abs(p2.x - p1.x), Math.abs(p2.y - p1.y));
        const pairs: Array<[string, string]> = [
            [lineIds[0], lineIds[1]],
            [lineIds[1], lineIds[2]],
            [lineIds[2], lineIds[3]],
            [lineIds[3], lineIds[0]]
        ];
        for (const [a, b] of pairs) {
            const result = await this.filletCorner(a, b, radius);
            if (!result.success) {
                this.inProgress = undefined;
                this.status = { ...this.status, lastAutoConstraints: [], hint: result.error };
                this.emitChange();
                return;
            }
        }
        this.applyRectangleAxisAutos(lineIds, auto);
        this.inProgress = undefined;
        await this.commit(auto);
        this.emitChange();
    }

    private applyRectangleAxisAutos(lineIds: string[], auto: AutoConstraintFeedback[]): void {
        for (const lineId of lineIds) {
            const line = this.primitives.get(lineId) as SketchLine & PrimitiveMeta;
            const a = this.getPointPosition(line.p1Id);
            const b = this.getPointPosition(line.p2Id);
            if (a !== undefined && b !== undefined) {
                this.addAxisAutoConstraint(lineId, a, b, auto);
            }
        }
    }

    /**
     * Build a regular polygon around a staged center through a vertex.
     *
     * Consecutive sides share endpoint ids (coincident closure, like the
     * rectangle tool) and carry equal-length constraints around the ring.
     */
    private buildPolygon(center: Point2, vertex: Point2, vertexId: string, auto: AutoConstraintFeedback[]): void {
        const n = this.polygonSides;
        const radius = Math.hypot(vertex.x - center.x, vertex.y - center.y);
        const base = Math.atan2(vertex.y - center.y, vertex.x - center.x);
        const pointIds = [vertexId];
        for (let i = 1; i < n; i++) {
            const corner = arcPointAt(center, radius, base + (i * 2 * Math.PI) / n);
            const id = this.nextId('point');
            this.addPointInternal(id, corner.x, corner.y, false);
            pointIds.push(id);
        }
        const lineIds: string[] = [];
        for (let i = 0; i < n; i++) {
            const lineId = this.nextId('line');
            this.addLineInternal(lineId, pointIds[i], pointIds[(i + 1) % n], false);
            lineIds.push(lineId);
        }
        for (let i = 0; i < n - 1; i++) {
            const equalId = this.nextId('equal');
            this.solver.addConstraintEqual(equalId, lineIds[i], lineIds[i + 1], { driving: true });
            this.constraints.set(equalId, { id: equalId, kind: 'equal', targetIds: [lineIds[i], lineIds[i + 1]], driving: true });
            auto.push({ kind: 'equal', ids: [equalId] });
        }
    }

    private async clickPolygon(snapped: SnapResult): Promise<void> {
        const auto: AutoConstraintFeedback[] = [];
        if (this.inProgress === undefined || this.inProgress.tool !== 'polygon') {
            const centerId = this.addPointForTool(snapped, auto);
            this.inProgress = { tool: 'polygon', stage: 1, centerId, center: snapped.point };
            this.status = { ...this.status, lastAutoConstraints: auto };
            this.emitChange();
            return;
        }
        const radius = Math.hypot(snapped.point.x - this.inProgress.center.x, snapped.point.y - this.inProgress.center.y);
        if (radius < 1e-9) {
            this.status = { ...this.status, lastAutoConstraints: [], hint: 'Polygon needs a vertex away from the center' };
            this.emitChange();
            return;
        }
        const vertexId = this.addPointForTool(snapped, auto);
        this.buildPolygon(this.inProgress.center, snapped.point, vertexId, auto);
        this.inProgress = undefined;
        await this.commit(auto);
        this.emitChange();
    }

    /**
     * Build an annular-sector arc slot: two concentric arcs (the long walls)
     * joined by two chord end caps, each tangent to the inner arc at the
     * staged start angle. The staged start point is reused as the first inner
     * junction; the staged end point only fixed the angular span and is
     * removed. Returns an error message when the gesture is degenerate.
     */
    private buildArcSlot(
        centerId: string,
        center: Point2,
        start: Point2,
        startId: string,
        span: number,
        outerRadius: number,
        auto: AutoConstraintFeedback[]
    ): void {
        const innerRadius = Math.hypot(start.x - center.x, start.y - center.y);
        const startAngle = angleOfPoint(start, center);
        const midAngle = startAngle + span / 2;
        const delta = Math.acos(Math.min(1, innerRadius / outerRadius));
        const innerMid = arcPointAt(center, innerRadius, midAngle);
        const outerMid = arcPointAt(center, outerRadius, midAngle);

        const innerEnd = arcPointAt(center, innerRadius, startAngle + span);
        const innerEndId = this.nextId('point');
        this.addPointInternal(innerEndId, innerEnd.x, innerEnd.y, false);
        const outerStart = arcPointAt(center, outerRadius, startAngle - delta);
        const outerStartId = this.nextId('point');
        this.addPointInternal(outerStartId, outerStart.x, outerStart.y, false);
        const outerEnd = arcPointAt(center, outerRadius, startAngle + span + delta);
        const outerEndId = this.nextId('point');
        this.addPointInternal(outerEndId, outerEnd.x, outerEnd.y, false);

        const outerAngles = arcAnglesFromThreePoints(center, outerStart, outerMid, outerEnd);
        const outerId = this.nextId('arc');
        this.addArcInternal(outerId, centerId, outerRadius, outerAngles.startAngle, outerAngles.endAngle, outerStartId, outerEndId, false);
        const innerAngles = arcAnglesFromThreePoints(center, innerEnd, innerMid, start);
        const innerId = this.nextId('arc');
        this.addArcInternal(innerId, centerId, innerRadius, innerAngles.startAngle, innerAngles.endAngle, innerEndId, startId, false);

        const line1Id = this.nextId('line');
        const line2Id = this.nextId('line');
        this.addLineInternal(line1Id, startId, outerStartId, false);
        this.addLineInternal(line2Id, innerEndId, outerEndId, false);

        for (const [lineId, arcId] of [
            [line1Id, innerId],
            [line2Id, innerId]
        ] as Array<[string, string]>) {
            const tangentId = this.nextId('tangent');
            this.solver.addConstraintTangent(tangentId, lineId, arcId, { driving: true });
            this.constraints.set(tangentId, { id: tangentId, kind: 'tangent', targetIds: [lineId, arcId], driving: true });
            auto.push({ kind: 'tangent', ids: [tangentId] });
        }
        const equalId = this.nextId('equal');
        this.solver.addConstraintEqual(equalId, line1Id, line2Id, { driving: true });
        this.constraints.set(equalId, { id: equalId, kind: 'equal', targetIds: [line1Id, line2Id], driving: true });
        auto.push({ kind: 'equal', ids: [equalId] });
    }

    private async clickArcSlot(snapped: SnapResult): Promise<void> {
        const auto: AutoConstraintFeedback[] = [];
        if (this.inProgress === undefined || this.inProgress.tool !== 'arcSlot') {
            const centerId = this.addPointForTool(snapped, auto);
            this.inProgress = { tool: 'arcSlot', stage: 1, centerId, center: snapped.point };
            this.status = { ...this.status, lastAutoConstraints: auto };
            this.emitChange();
            return;
        }
        if (this.inProgress.stage === 1) {
            const radius = Math.hypot(snapped.point.x - this.inProgress.center.x, snapped.point.y - this.inProgress.center.y);
            if (radius < 1e-9) {
                this.status = { ...this.status, lastAutoConstraints: [], hint: 'Arc slot needs a start point away from the center' };
                this.emitChange();
                return;
            }
            const startId = this.addPointForTool(snapped, auto);
            this.inProgress = {
                tool: 'arcSlot',
                stage: 2,
                centerId: this.inProgress.centerId,
                center: this.inProgress.center,
                startId,
                start: snapped.point
            };
            this.status = { ...this.status, lastAutoConstraints: auto };
            this.emitChange();
            return;
        }
        if (this.inProgress.stage === 2) {
            const { center, start } = this.inProgress;
            if (start === undefined) {
                return;
            }
            if (Math.hypot(snapped.point.x - center.x, snapped.point.y - center.y) < 1e-9) {
                this.status = { ...this.status, lastAutoConstraints: [], hint: 'Arc slot needs an end point away from the center' };
                this.emitChange();
                return;
            }
            const startAngle = angleOfPoint(start, center);
            let span = (angleOfPoint(snapped.point, center) - startAngle) % (2 * Math.PI);
            if (span < 0) {
                span += 2 * Math.PI;
            }
            if (span < 1e-6 || 2 * Math.PI - span < 1e-6) {
                this.status = { ...this.status, lastAutoConstraints: [], hint: 'Arc slot start and end angles must differ' };
                this.emitChange();
                return;
            }
            const endId = this.addPointForTool(snapped, auto);
            this.inProgress = {
                tool: 'arcSlot',
                stage: 3,
                centerId: this.inProgress.centerId,
                center,
                startId: this.inProgress.startId,
                start,
                endId,
                end: snapped.point
            };
            this.status = { ...this.status, lastAutoConstraints: auto };
            this.emitChange();
            return;
        }
        const { centerId, center, start, startId, endId } = this.inProgress;
        if (start === undefined || startId === undefined || endId === undefined) {
            return;
        }
        const innerRadius = Math.hypot(start.x - center.x, start.y - center.y);
        const width = Math.abs(Math.hypot(snapped.point.x - center.x, snapped.point.y - center.y) - innerRadius);
        if (width < 1e-9) {
            this.status = {
                ...this.status,
                lastAutoConstraints: [],
                hint: 'Slot width must be non-zero — pick a width point off the wall'
            };
            this.emitChange();
            return;
        }
        const startAngle = angleOfPoint(start, center);
        let span = (angleOfPoint(this.inProgress.end!, center) - startAngle) % (2 * Math.PI);
        if (span < 0) {
            span += 2 * Math.PI;
        }
        this.buildArcSlot(centerId, center, start, startId, span, innerRadius + width, auto);
        this.removePrimitiveAndConstraints(endId);
        this.inProgress = undefined;
        await this.commit(auto);
        this.emitChange();
    }

    /** Shared corner point id of two lines, or undefined when they meet nowhere. */
    private sharedCornerOf(lineId1: string, lineId2: string): string | undefined {
        const l1 = this.primitives.get(lineId1);
        const l2 = this.primitives.get(lineId2);
        if (l1?.type !== 'line' || l2?.type !== 'line') {
            return undefined;
        }
        return [l1.p1Id, l1.p2Id].find((e) => e === l2.p1Id || e === l2.p2Id);
    }

    /** Nearest line to a click within the pick tolerance, for fillet/chamfer staging. */
    private resolveLineTarget(snapped: SnapResult, raw: Point2): string | undefined {
        if (snapped.sourceId !== undefined) {
            const target = this.primitives.get(snapped.sourceId);
            if (target?.type === 'line') {
                return target.id;
            }
        }
        return this.findNearestCurve(raw, LINE_TARGET, this.pickTolerance())?.id;
    }

    private async clickSketchFillet(snapped: SnapResult, raw: Point2): Promise<void> {
        if (this.inProgress === undefined || this.inProgress.tool !== 'sketchFillet') {
            const lineId = this.resolveLineTarget(snapped, raw);
            if (lineId === undefined) {
                this.status = { ...this.status, lastAutoConstraints: [], hint: 'Sketch fillet: click the first line' };
                this.emitChange();
                return;
            }
            this.inProgress = { tool: 'sketchFillet', stage: 1, lineAId: lineId };
            this.status = { ...this.status, lastAutoConstraints: [] };
            this.emitChange();
            return;
        }
        if (this.inProgress.stage === 1) {
            const lineId = this.resolveLineTarget(snapped, raw);
            if (
                lineId === undefined ||
                lineId === this.inProgress.lineAId ||
                this.sharedCornerOf(this.inProgress.lineAId, lineId) === undefined
            ) {
                this.status = {
                    ...this.status,
                    lastAutoConstraints: [],
                    hint: 'Sketch fillet needs a second line sharing a corner with the first'
                };
                this.emitChange();
                return;
            }
            this.inProgress = { tool: 'sketchFillet', stage: 2, lineAId: this.inProgress.lineAId, lineBId: lineId };
            this.status = { ...this.status, lastAutoConstraints: [] };
            this.emitChange();
            return;
        }
        const { lineAId, lineBId } = this.inProgress;
        if (lineBId === undefined) {
            return;
        }
        const corner = this.sharedCornerOf(lineAId, lineBId);
        const cornerPos = corner === undefined ? undefined : this.getPointPosition(corner);
        if (corner === undefined || cornerPos === undefined) {
            this.status = { ...this.status, lastAutoConstraints: [], hint: 'Sketch fillet needs two lines sharing a corner point' };
            this.emitChange();
            return;
        }
        const radius = Math.hypot(snapped.point.x - cornerPos.x, snapped.point.y - cornerPos.y);
        if (!(radius > 1e-9)) {
            this.status = {
                ...this.status,
                lastAutoConstraints: [],
                hint: 'Sketch fillet radius must be positive — click farther from the corner'
            };
            this.emitChange();
            return;
        }
        const result = await this.filletCorner(lineAId, lineBId, radius);
        if (!result.success) {
            this.status = { ...this.status, lastAutoConstraints: [], hint: result.error };
            this.emitChange();
            return;
        }
        this.inProgress = undefined;
        this.emitChange();
    }

    private async clickSketchChamfer(snapped: SnapResult, raw: Point2): Promise<void> {
        if (this.inProgress === undefined || this.inProgress.tool !== 'sketchChamfer') {
            const lineId = this.resolveLineTarget(snapped, raw);
            if (lineId === undefined) {
                this.status = { ...this.status, lastAutoConstraints: [], hint: 'Sketch chamfer: click the first line' };
                this.emitChange();
                return;
            }
            this.inProgress = { tool: 'sketchChamfer', stage: 1, lineAId: lineId };
            this.status = { ...this.status, lastAutoConstraints: [] };
            this.emitChange();
            return;
        }
        if (this.inProgress.stage === 1) {
            const lineId = this.resolveLineTarget(snapped, raw);
            if (
                lineId === undefined ||
                lineId === this.inProgress.lineAId ||
                this.sharedCornerOf(this.inProgress.lineAId, lineId) === undefined
            ) {
                this.status = {
                    ...this.status,
                    lastAutoConstraints: [],
                    hint: 'Sketch chamfer needs a second line sharing a corner with the first'
                };
                this.emitChange();
                return;
            }
            this.inProgress = { tool: 'sketchChamfer', stage: 2, lineAId: this.inProgress.lineAId, lineBId: lineId };
            this.status = { ...this.status, lastAutoConstraints: [] };
            this.emitChange();
            return;
        }
        const { lineAId, lineBId } = this.inProgress;
        if (lineBId === undefined) {
            return;
        }
        const corner = this.sharedCornerOf(lineAId, lineBId);
        const cornerPos = corner === undefined ? undefined : this.getPointPosition(corner);
        if (corner === undefined || cornerPos === undefined) {
            this.status = { ...this.status, lastAutoConstraints: [], hint: 'Sketch chamfer needs two lines sharing a corner point' };
            this.emitChange();
            return;
        }
        const distance = Math.hypot(snapped.point.x - cornerPos.x, snapped.point.y - cornerPos.y);
        if (!(distance > 1e-9)) {
            this.status = {
                ...this.status,
                lastAutoConstraints: [],
                hint: 'Sketch chamfer distance must be positive — click farther from the corner'
            };
            this.emitChange();
            return;
        }
        const result = await this.chamferCorner(lineAId, lineBId, distance);
        if (!result.success) {
            this.status = { ...this.status, lastAutoConstraints: [], hint: result.error };
            this.emitChange();
            return;
        }
        this.inProgress = undefined;
        this.emitChange();
    }

    private async clickPolyline(snapped: SnapResult): Promise<void> {
        const auto: AutoConstraintFeedback[] = [];
        if (this.inProgress === undefined || this.inProgress.tool !== 'polyline') {
            const id = this.addPointForTool(snapped, auto);
            this.inProgress = { tool: 'polyline', lastId: id, last: snapped.point, segmentIds: [] };
            this.status = { ...this.status, lastAutoConstraints: auto };
            this.emitChange();
            return;
        }
        if (this.polylineMode === 'line') {
            const p2 = snapped.point;
            if (Math.hypot(p2.x - this.inProgress.last.x, p2.y - this.inProgress.last.y) < 1e-12) {
                this.status = { ...this.status, lastAutoConstraints: [] };
                this.emitChange();
                return;
            }
            const p2Id = this.addPointForTool(snapped, auto);
            const lineId = this.nextId('line');
            this.addLineInternal(lineId, this.inProgress.lastId, p2Id, false);
            this.addAxisAutoConstraint(lineId, this.inProgress.last, p2, auto);
            this.inProgress = {
                tool: 'polyline',
                lastId: p2Id,
                last: p2,
                segmentIds: [...this.inProgress.segmentIds, lineId]
            };
            await this.commit(auto);
            this.emitChange();
            return;
        }
        if (this.inProgress.arcMid === undefined) {
            const midId = this.addPointForTool(snapped, auto);
            this.inProgress = { ...this.inProgress, arcMidId: midId, arcMid: snapped.point };
            this.status = { ...this.status, lastAutoConstraints: auto };
            this.emitChange();
            return;
        }
        const { last, arcMid } = this.inProgress;
        const end = snapped.point;
        if (Math.hypot(end.x - last.x, end.y - last.y) < 1e-12 || Math.hypot(end.x - arcMid.x, end.y - arcMid.y) < 1e-12) {
            this.status = { ...this.status, lastAutoConstraints: [] };
            this.emitChange();
            return;
        }
        let center: Point2;
        try {
            center = circleCenterFromThreePoints(last, arcMid, end);
        } catch {
            this.status = {
                ...this.status,
                lastAutoConstraints: [],
                hint: 'Polyline arc points are collinear — pick a different endpoint'
            };
            this.emitChange();
            return;
        }
        const radius = Math.hypot(last.x - center.x, last.y - center.y);
        const angles = arcAnglesFromThreePoints(center, last, arcMid, end);
        const centerId = this.nextId('point');
        this.addPointInternal(centerId, center.x, center.y, false);
        const endId = this.addPointForTool(snapped, auto);
        const arcId = this.nextId('arc');
        this.addArcInternal(arcId, centerId, radius, angles.startAngle, angles.endAngle, this.inProgress.lastId, endId, false);
        this.inProgress = {
            tool: 'polyline',
            lastId: endId,
            last: end,
            segmentIds: [...this.inProgress.segmentIds, arcId]
        };
        await this.commit(auto);
        this.emitChange();
    }

    /**
     * Insert a chamfer between two lines sharing a corner point.
     *
     * Mirrors {@link filletCorner}: both lines are shortened to equal legs of
     * the given distance from the corner (same-id rebuild, so line-level
     * constraints survive via replay) and the corner point is removed. The
     * legs meet a fresh connecting line whose ends are joined with coincident
     * constraints at the two new corners.
     */
    async chamferCorner(lineId1: string, lineId2: string, distance: number): Promise<ChamferResult> {
        const l1 = this.primitives.get(lineId1);
        const l2 = this.primitives.get(lineId2);
        if (l1?.type !== 'line' || l2?.type !== 'line') {
            return { success: false, error: 'chamfer requires two lines' };
        }
        if (lineId1 === lineId2) {
            return { success: false, error: 'chamfer requires two distinct lines' };
        }
        const corner = this.sharedCornerOf(lineId1, lineId2);
        if (corner === undefined) {
            return { success: false, error: 'chamfer requires two lines sharing a corner point' };
        }
        if (!Number.isFinite(distance) || distance <= 0) {
            return { success: false, error: `Chamfer distance must be positive, got ${distance}` };
        }
        const cornerPos = this.getPointPosition(corner);
        const pos1 = this.getPointPosition(l1.p1Id === corner ? l1.p2Id : l1.p1Id);
        const pos2 = this.getPointPosition(l2.p1Id === corner ? l2.p2Id : l2.p1Id);
        if (cornerPos === undefined || pos1 === undefined || pos2 === undefined) {
            return { success: false, error: 'chamfer corner references unsolved geometry' };
        }
        const len1 = Math.hypot(pos1.x - cornerPos.x, pos1.y - cornerPos.y);
        const len2 = Math.hypot(pos2.x - cornerPos.x, pos2.y - cornerPos.y);
        if (distance >= len1 || distance >= len2) {
            return {
                success: false,
                error: `Chamfer distance ${distance} is too large for the corner (max ${Math.min(len1, len2).toFixed(6)})`
            };
        }
        const blockers = [...this.constraints.values()].filter((record) => record.targetIds.includes(corner));
        if (blockers.length > 0) {
            return {
                success: false,
                error: `Corner point '${corner}' is constrained (${blockers.map((r) => r.id).join(', ')}); remove those constraints first`
            };
        }
        const dimensionBlockers = [...this.dimensions.values()].filter((dimension) => dimension.targetIds.includes(corner));
        if (dimensionBlockers.length > 0) {
            return {
                success: false,
                error: `Corner point '${corner}' drives dimension(s) (${dimensionBlockers.map((d) => d.id).join(', ')}); remove them first`
            };
        }

        const u = { x: (pos1.x - cornerPos.x) / len1, y: (pos1.y - cornerPos.y) / len1 };
        const v = { x: (pos2.x - cornerPos.x) / len2, y: (pos2.y - cornerPos.y) / len2 };
        const t1 = { x: cornerPos.x + u.x * distance, y: cornerPos.y + u.y * distance };
        const t2 = { x: cornerPos.x + v.x * distance, y: cornerPos.y + v.y * distance };
        const e1Id = this.nextId('point');
        const e2Id = this.nextId('point');
        const f1Id = this.nextId('point');
        const f2Id = this.nextId('point');
        this.addPointInternal(e1Id, t1.x, t1.y, false);
        this.addPointInternal(e2Id, t2.x, t2.y, false);
        this.addPointInternal(f1Id, t1.x, t1.y, false);
        this.addPointInternal(f2Id, t2.x, t2.y, false);

        try {
            const refs = [...this.constraints.values()].filter(
                (record) => record.targetIds.includes(lineId1) || record.targetIds.includes(lineId2)
            );
            this.solver.removePrimitive(lineId1);
            this.solver.removePrimitive(lineId2);
            const newEnds1: [string, string] = [l1.p1Id === corner ? e1Id : l1.p1Id, l1.p2Id === corner ? e1Id : l1.p2Id];
            const newEnds2: [string, string] = [l2.p1Id === corner ? e2Id : l2.p1Id, l2.p2Id === corner ? e2Id : l2.p2Id];
            this.solver.addLine(lineId1, newEnds1[0], newEnds1[1], { construction: l1.construction });
            this.solver.addLine(lineId2, newEnds2[0], newEnds2[1], { construction: l2.construction });
            this.primitives.set(lineId1, { ...l1, p1Id: newEnds1[0], p2Id: newEnds1[1] });
            this.primitives.set(lineId2, { ...l2, p1Id: newEnds2[0], p2Id: newEnds2[1] });
            for (const record of refs) {
                this.replayConstraintRecord(record);
            }
            this.solver.removePrimitive(corner);
            this.primitives.delete(corner);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await this.commit([]);
            this.emitChange();
            return { success: false, error: message };
        }

        const lineId = this.nextId('line');
        this.addLineInternal(lineId, f1Id, f2Id, false);
        for (const [a, b] of [
            [e1Id, f1Id],
            [e2Id, f2Id]
        ] as Array<[string, string]>) {
            const coincidentId = this.nextId('coincident');
            this.solver.addConstraintCoincident(coincidentId, a, b, { driving: true });
            this.constraints.set(coincidentId, { id: coincidentId, kind: 'coincident', targetIds: [a, b], driving: true });
        }
        await this.commit([]);
        this.emitChange();
        return { success: true, lineId };
    }

    /**
     * Clip a segment back to its nearest intersection with another curve.
     *
     * Lines and arcs are shortened by moving the nearer end onto the
     * intersection; circles are opened into an arc that drops the span
     * containing the click. Constraints owned solely by removed portions
     * (point-on-object records whose point left the curve) are deleted, and
     * the new trim endpoints gain coincident/point-on-object hygiene. Fails
     * clearly when nothing intersects the target.
     */
    async trimAt(raw: Point2, modifiers?: { disableSnap?: boolean }): Promise<EditCurveResult> {
        const { result, auto } = await this.doTrim(raw, modifiers);
        this.status = result.success
            ? { ...this.status, lastAutoConstraints: auto }
            : { ...this.status, lastAutoConstraints: [], hint: result.error };
        this.emitChange();
        return result;
    }

    /**
     * Extend an open line/arc end to the next intersecting curve.
     *
     * The end nearest the click is extended along the line direction (or the
     * arc end tangent) until it meets another curve. Same constraint hygiene
     * as {@link trimAt}. Fails clearly with no end nearby or nothing ahead.
     */
    async extendAt(raw: Point2, modifiers?: { disableSnap?: boolean }): Promise<EditCurveResult> {
        const { result, auto } = await this.doExtend(raw, modifiers);
        this.status = result.success
            ? { ...this.status, lastAutoConstraints: auto }
            : { ...this.status, lastAutoConstraints: [], hint: result.error };
        this.emitChange();
        return result;
    }

    /**
     * Split a line, arc, or circle at the clicked interior point.
     *
     * Lines and arcs become two entities sharing the new split point (the
     * first half keeps the original id so its constraints survive; drifting
     * point-on-object records are remapped onto the correct half). Circles
     * become two semicircular arcs sharing the split point and its antipode.
     * Construction flags are preserved on every new entity.
     */
    async splitAt(raw: Point2, modifiers?: { disableSnap?: boolean }): Promise<EditCurveResult> {
        const { result, auto } = await this.doSplit(raw, modifiers);
        this.status = result.success
            ? { ...this.status, lastAutoConstraints: auto }
            : { ...this.status, lastAutoConstraints: [], hint: result.error };
        this.emitChange();
        return result;
    }

    /**
     * Drop every solver-tagged redundant constraint and return the count.
     *
     * Re-solves to a fixpoint so cascades are fully cleared. Partially
     * redundant constraints are left alone (they are consistent today).
     */
    async removeRedundantConstraints(): Promise<number> {
        let removed = 0;
        for (;;) {
            const result = await this.solver.solve();
            const tagged = result.redundant.filter((id) => this.constraints.has(id));
            if (tagged.length === 0) {
                break;
            }
            for (const id of tagged) {
                this.removeConstraintInternal(id);
            }
            removed += tagged.length;
        }
        await this.commit([]);
        this.emitChange();
        return removed;
    }

    /**
     * Translate the selected entities by a base-to-target vector (Move tool core).
     *
     * In-place rigid translation: owned points move by the vector while curve
     * scalars (radii, angles, radmin) are preserved. Bridging constraints
     * (mixed moved/unmoved targets) and fixes on moved points are dropped so
     * the solver cannot fight the translation; fully-internal constraints are
     * kept. New coincident joins are added where moved points land on existing
     * points. Re-solves after the op. Rejects empty selections.
     */
    async moveSelection(base: Point2, target: Point2): Promise<TransformResult> {
        const vector = { x: target.x - base.x, y: target.y - base.y };
        if (Math.hypot(vector.x, vector.y) < 1e-12) {
            return { success: false, error: 'Move needs a base point and a distinct target point' };
        }
        return this.applyRigidTransformToSelection((p) => translatePoint(p, vector), 'Move');
    }

    /**
     * Copy the selected entities translated by a base-to-target vector.
     *
     * Originals are kept; fresh copies carry transformed coordinates with
     * construction flags preserved. Internal constraints (all targets inside
     * the selection closure) are remapped onto the copies like
     * {@link carbonCopyFrom}; bridging constraints are not copied. Rejects
     * empty selections.
     */
    async copySelection(base: Point2, target: Point2): Promise<TransformResult> {
        const vector = { x: target.x - base.x, y: target.y - base.y };
        if (Math.hypot(vector.x, vector.y) < 1e-12) {
            return { success: false, error: 'Copy needs a base point and a distinct target point' };
        }
        return this.copySelectionWithPointTransform((p) => translatePoint(p, vector), undefined, 'Copy');
    }

    /**
     * Rotate the selected entities about a center by the swept angle.
     *
     * The angle is measured from the +X axis to the angle point
     * (`atan2(anglePoint - center)`). Arc start/end angles rotate with the
     * points; radii and ellipse radmin are preserved. Internal
     * horizontal/vertical constraints are dropped (rotation changes
     * orientation) plus the usual bridging/fix hygiene. Rejects empty
     * selections.
     */
    async rotateSelection(center: Point2, anglePoint: Point2): Promise<TransformResult> {
        if (Math.hypot(anglePoint.x - center.x, anglePoint.y - center.y) < 1e-12) {
            return { success: false, error: 'Rotate needs a center and an angle point away from the center' };
        }
        const angle = angleOfPoint(anglePoint, center);
        return this.applyRotationToSelection(center, angle);
    }

    /**
     * Mirror the selected entities across an axis line into fresh copies.
     *
     * Copies carry mirrored coordinates with construction flags preserved and
     * internal constraints remapped like {@link carbonCopyFrom}; each original
     * point is then paired to its copy with a solver symmetry constraint about
     * the axis line (point-level only, honoring the ellipse/B-spline scope
     * rule). Rejects empty selections.
     */
    async mirrorSelection(axisLineId: string): Promise<TransformResult> {
        const axis = this.primitives.get(axisLineId);
        if (axis === undefined) {
            return { success: false, error: `Unknown primitive '${axisLineId}'` };
        }
        if (axis.type !== 'line') {
            return { success: false, error: `Mirror needs an axis line, got '${axisLineId}' (${axis.type})` };
        }
        const a = this.getPointPosition(axis.type === 'line' ? axis.p1Id : '');
        const b = this.getPointPosition(axis.type === 'line' ? axis.p2Id : '');
        if (a === undefined || b === undefined) {
            return { success: false, error: `Mirror axis '${axisLineId}' references unsolved geometry` };
        }
        if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-12) {
            return { success: false, error: `Mirror axis '${axisLineId}' is degenerate` };
        }
        return this.mirrorSelectionAcrossAxis(axisLineId, a, b);
    }

    /**
     * Scale primitives about a center by a uniform factor (inline popover core).
     *
     * Contract name `scale` is an alias of this method for the UI agent.
     * In-place: owned points scale about the center while circle/arc radii
     * and ellipse radmin multiply by the factor (arc angles preserved).
     * Internal distance/radius/diameter values scale with the factor;
     * horizontal/vertical survive (orientation preserved); fixes on moved
     * points and bridging constraints are dropped. Re-solves after the op.
     */
    async scalePrimitives(ids: string[], center: Point2, factor: number): Promise<TransformResult> {
        if (ids.length === 0) {
            return { success: false, error: 'Scale needs at least one selected primitive' };
        }
        if (!Number.isFinite(factor) || factor <= 0) {
            return { success: false, error: `Scale factor must be finite positive, got ${factor}` };
        }
        if (!Number.isFinite(center.x) || !Number.isFinite(center.y)) {
            return { success: false, error: 'Scale center must be finite coordinates' };
        }
        return this.applyScaleToIds(ids, center, factor);
    }

    /** Alias of {@link scalePrimitives} under the UI-agent contract name. */
    async scale(ids: string[], center: Point2, factor: number): Promise<TransformResult> {
        return this.scalePrimitives(ids, center, factor);
    }

    /**
     * Copy primitives into a rows-by-cols grid spaced by (dx, dy).
     *
     * Contract name `arrayRect` is an alias of this method for the UI agent.
     * Plain copies: construction flags preserved, no constraints or dimensions
     * on the copies. The (0, 0) cell is the original; every other cell is a
     * fresh copy offset by `(col * dx, row * dy)`. Counts must be positive
     * integers; spacing must be finite with at least one nonzero component.
     */
    async rectangularArray(ids: string[], dx: number, dy: number, rows: number, cols: number): Promise<TransformResult> {
        if (ids.length === 0) {
            return { success: false, error: 'Rectangular array needs at least one selected primitive' };
        }
        if (!Number.isInteger(rows) || rows <= 0) {
            return { success: false, error: `Rectangular array rows must be a positive integer, got ${rows}` };
        }
        if (!Number.isInteger(cols) || cols <= 0) {
            return { success: false, error: `Rectangular array cols must be a positive integer, got ${cols}` };
        }
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
            return { success: false, error: `Rectangular array spacing must be finite, got (${dx}, ${dy})` };
        }
        if (Math.hypot(dx, dy) < 1e-12) {
            return { success: false, error: 'Rectangular array spacing must be nonzero' };
        }
        return this.applyRectangularArray(ids, dx, dy, rows, cols);
    }

    /** Alias of {@link rectangularArray} under the UI-agent contract name. */
    async arrayRect(ids: string[], dx: number, dy: number, rows: number, cols: number): Promise<TransformResult> {
        return this.rectangularArray(ids, dx, dy, rows, cols);
    }

    /**
     * Offset each listed wire entity in parallel by a signed distance.
     *
     * Lines shift along the left normal of their `p1 -> p2` direction;
     * circles/arcs grow their radius by the distance (arcs keep center and
     * angles, start/end points re-derived). Only lines, circles, and arcs are
     * accepted (point-level-only rule: ellipses and B-splines are rejected
     * with a clear error). Radius constraints on offset circles/arcs are
     * dropped (they pin the old radius); detached point-on-object records are
     * pruned.
     *
     * `options.autoTrim` (default true) rejoins offset lines at shared
     * corners: after the per-entity parallel offset, every sketch point used
     * exclusively by exactly two offset lines moves to the intersection of
     * the two offset lines (miter join — trims overlaps and closes gaps at
     * corners, the 2D analog of section/split auto-trim). Corners that cannot
     * join (parallel lines, intersections beyond the robustness cap, points
     * shared with non-offset geometry, or junctions of three or more lines)
     * keep the raw parallel offset; circles/arcs are never auto-trimmed. No
     * entity is ever deleted by auto-trim: unjoinable corners stay connected
     * (the first offset line's position wins) and non-participating geometry
     * is never dragged.
     */
    async offsetWire(ids: string[], distance: number, options?: { autoTrim?: boolean }): Promise<TransformResult> {
        if (ids.length === 0) {
            return { success: false, error: 'Offset needs at least one selected wire entity' };
        }
        if (!Number.isFinite(distance) || Math.abs(distance) < 1e-12) {
            return { success: false, error: `Offset distance must be finite nonzero, got ${distance}` };
        }
        return this.applyOffsetWire(ids, distance, options?.autoTrim ?? true);
    }

    /**
     * Join exactly two caller-selected open endpoints with a line.
     *
     * With no argument the session selection is used; pass explicit point ids
     * for headless use. Both ids must be open wire ends per
     * {@link findOpenVertices} (non-construction line/arc endpoints or
     * B-spline end poles used by exactly one segment). The new line's ends
     * gain coincident constraints to the joined points. Any other count or
     * non-open endpoints fail with a clear error.
     */
    async joinOpenEnds(pointIds?: string[]): Promise<JoinResult> {
        const selected = pointIds ?? this.getSelection();
        if (selected.length !== 2) {
            return { success: false, error: `Join needs exactly 2 selected open endpoints, got ${selected.length}` };
        }
        const [first, second] = selected;
        const firstPrimitive = this.primitives.get(first);
        const secondPrimitive = this.primitives.get(second);
        if (firstPrimitive === undefined) {
            return { success: false, error: `Unknown primitive '${first}'` };
        }
        if (secondPrimitive === undefined) {
            return { success: false, error: `Unknown primitive '${second}'` };
        }
        if (firstPrimitive.type !== 'point' || secondPrimitive.type !== 'point') {
            return { success: false, error: `Join needs two points, got ${firstPrimitive.type}/${secondPrimitive.type}` };
        }
        const openRoots = this.openVertexRoots();
        if (!openRoots.has(first) || !openRoots.has(second)) {
            return {
                success: false,
                error: `Join needs two open endpoints ('${first}', '${second}'): one or both are closed or construction-only`
            };
        }
        if (first === second) {
            return { success: false, error: 'Join needs two distinct open endpoints' };
        }
        const firstPos = this.getPointPosition(first);
        const secondPos = this.getPointPosition(second);
        if (firstPos === undefined || secondPos === undefined) {
            return { success: false, error: 'Join references unsolved geometry' };
        }
        if (Math.hypot(secondPos.x - firstPos.x, secondPos.y - firstPos.y) < 1e-12) {
            return { success: false, error: 'Join endpoints coincide; add a coincident constraint instead' };
        }
        const e1Id = this.nextId('point');
        const e2Id = this.nextId('point');
        this.addPointInternal(e1Id, firstPos.x, firstPos.y, false);
        this.addPointInternal(e2Id, secondPos.x, secondPos.y, false);
        const lineId = this.nextId('line');
        this.addLineInternal(lineId, e1Id, e2Id, false);
        for (const [a, b] of [
            [first, e1Id],
            [second, e2Id]
        ] as Array<[string, string]>) {
            const coincidentId = this.nextId('coincident');
            this.solver.addConstraintCoincident(coincidentId, a, b, { driving: true });
            this.constraints.set(coincidentId, { id: coincidentId, kind: 'coincident', targetIds: [a, b], driving: true });
        }
        await this.commit([]);
        this.emitChange();
        return { success: true, lineId };
    }

    /** Alias of {@link joinOpenEnds} under the UI-agent contract name. */
    async joinEnds(pointIds?: string[]): Promise<JoinResult> {
        return this.joinOpenEnds(pointIds);
    }

    private async clickMove(snapped: SnapResult): Promise<void> {
        if (this.inProgress === undefined || this.inProgress.tool !== 'move') {
            if (this.selectedIds.size === 0) {
                this.status = {
                    ...this.status,
                    lastAutoConstraints: [],
                    hint: 'Move needs a selection — select entities with the Select tool first'
                };
                this.emitChange();
                return;
            }
            this.inProgress = { tool: 'move', stage: 1, base: snapped.point };
            this.status = { ...this.status, lastAutoConstraints: [] };
            this.emitChange();
            return;
        }
        const result = await this.moveSelection(this.inProgress.base, snapped.point);
        this.inProgress = undefined;
        this.status = result.success
            ? { ...this.status, lastAutoConstraints: [] }
            : { ...this.status, lastAutoConstraints: [], hint: result.error };
        this.emitChange();
    }

    private async clickCopy(snapped: SnapResult): Promise<void> {
        if (this.inProgress === undefined || this.inProgress.tool !== 'copy') {
            if (this.selectedIds.size === 0) {
                this.status = {
                    ...this.status,
                    lastAutoConstraints: [],
                    hint: 'Copy needs a selection — select entities with the Select tool first'
                };
                this.emitChange();
                return;
            }
            this.inProgress = { tool: 'copy', stage: 1, base: snapped.point };
            this.status = { ...this.status, lastAutoConstraints: [] };
            this.emitChange();
            return;
        }
        const result = await this.copySelection(this.inProgress.base, snapped.point);
        this.inProgress = undefined;
        this.status = result.success
            ? { ...this.status, lastAutoConstraints: [] }
            : { ...this.status, lastAutoConstraints: [], hint: result.error };
        this.emitChange();
    }

    private async clickRotate(snapped: SnapResult): Promise<void> {
        if (this.inProgress === undefined || this.inProgress.tool !== 'rotate') {
            if (this.selectedIds.size === 0) {
                this.status = {
                    ...this.status,
                    lastAutoConstraints: [],
                    hint: 'Rotate needs a selection — select entities with the Select tool first'
                };
                this.emitChange();
                return;
            }
            this.inProgress = { tool: 'rotate', stage: 1, center: snapped.point };
            this.status = { ...this.status, lastAutoConstraints: [] };
            this.emitChange();
            return;
        }
        const result = await this.rotateSelection(this.inProgress.center, snapped.point);
        this.inProgress = undefined;
        this.status = result.success
            ? { ...this.status, lastAutoConstraints: [] }
            : { ...this.status, lastAutoConstraints: [], hint: result.error };
        this.emitChange();
    }

    private async clickMirrorTool(snapped: SnapResult, raw: Point2): Promise<void> {
        if (this.selectedIds.size === 0) {
            this.status = {
                ...this.status,
                lastAutoConstraints: [],
                hint: 'Mirror needs a selection — select entities with the Select tool first'
            };
            this.emitChange();
            return;
        }
        let axisLineId: string | undefined;
        if (snapped.sourceId !== undefined) {
            const target = this.primitives.get(snapped.sourceId);
            if (target?.type === 'line') {
                axisLineId = target.id;
            }
        }
        if (axisLineId === undefined) {
            axisLineId = this.findNearestCurve(raw, LINE_TARGET, this.pickTolerance())?.id;
        }
        if (axisLineId === undefined) {
            this.status = { ...this.status, lastAutoConstraints: [], hint: 'Mirror needs an axis line — click a line in the sketch' };
            this.emitChange();
            return;
        }
        const result = await this.mirrorSelection(axisLineId);
        this.status = result.success
            ? { ...this.status, lastAutoConstraints: [] }
            : { ...this.status, lastAutoConstraints: [], hint: result.error };
        this.emitChange();
    }

    /** Open wire-end roots (coincident-merged) backing {@link joinOpenEnds} validation. */
    private openVertexRoots(): Set<string> {
        const roots = new Set<string>();
        for (const vertex of this.findOpenVertices()) {
            roots.add(vertex.pointId);
        }
        // findOpenVertices merges coincident points and reports the smallest
        // member; joins also accept any other member of the same root.
        const parent = new Map<string, string>();
        const find = (id: string): string => {
            const p = parent.get(id) ?? id;
            if (p === id) {
                return id;
            }
            const root = find(p);
            parent.set(id, root);
            return root;
        };
        const union = (a: string, b: string): void => {
            const ra = find(a);
            const rb = find(b);
            if (ra !== rb) {
                parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
            }
        };
        for (const primitive of this.primitives.values()) {
            if (primitive.type === 'point') {
                find(primitive.id);
            }
        }
        for (const record of this.constraints.values()) {
            if (record.kind === 'coincident' && record.targetIds.length === 2) {
                union(record.targetIds[0], record.targetIds[1]);
            }
        }
        const openRoots = new Set<string>();
        for (const vertex of this.findOpenVertices()) {
            openRoots.add(find(vertex.pointId));
        }
        for (const primitive of this.primitives.values()) {
            if (primitive.type === 'point' && openRoots.has(find(primitive.id))) {
                roots.add(primitive.id);
            }
        }
        return roots;
    }

    /** Expand selected ids into the curve + owned-point closure for transforms. */
    private transformClosure(ids: string[]): { pointIds: Set<string>; curveIds: Set<string>; allIds: Set<string> } | { error: string } {
        const pointIds = new Set<string>();
        const curveIds = new Set<string>();
        const allIds = new Set<string>();
        for (const id of ids) {
            const primitive = this.primitives.get(id);
            if (primitive === undefined) {
                return { error: `Unknown primitive '${id}'` };
            }
            allIds.add(id);
            if (primitive.type === 'point') {
                pointIds.add(id);
            } else if (primitive.type === 'line') {
                curveIds.add(id);
                for (const endId of [primitive.p1Id, primitive.p2Id]) {
                    pointIds.add(endId);
                    allIds.add(endId);
                }
            } else if (primitive.type === 'circle') {
                curveIds.add(id);
                pointIds.add(primitive.centerId);
                allIds.add(primitive.centerId);
            } else if (primitive.type === 'arc') {
                curveIds.add(id);
                for (const owned of [primitive.centerId, primitive.startId, primitive.endId]) {
                    pointIds.add(owned);
                    allIds.add(owned);
                }
            } else if (primitive.type === 'ellipse') {
                curveIds.add(id);
                for (const owned of [primitive.centerId, primitive.focus1Id]) {
                    pointIds.add(owned);
                    allIds.add(owned);
                }
            } else if (primitive.type === 'bspline') {
                curveIds.add(id);
                for (const poleId of primitive.poleIds) {
                    pointIds.add(poleId);
                    allIds.add(poleId);
                }
            }
        }
        return { pointIds, curveIds, allIds };
    }

    /** Drop bridging constraints plus fixes on moved points before an in-place transform. */
    private dropTransformBlockers(allIds: Set<string>, pointIds: Set<string>): void {
        for (const [id, record] of [...this.constraints]) {
            const inside = record.targetIds.filter((target) => allIds.has(target));
            if (inside.length === 0) {
                continue;
            }
            if (record.kind === 'fix' && record.targetIds.length === 1 && pointIds.has(record.targetIds[0])) {
                this.removeConstraintInternal(id);
                continue;
            }
            const outside = record.targetIds.filter((target) => !allIds.has(target));
            if (outside.length > 0) {
                this.removeConstraintInternal(id);
            }
        }
    }

    /** Move owned points to computed positions through the solver pin/solve/unpin cycle. */
    private async applyPointMoves(moves: Map<string, Point2>): Promise<void> {
        const pinned: Array<{ xId: string; yId: string }> = [];
        for (const [pointId, pos] of moves) {
            finite(pos.x, `Target x for '${pointId}'`);
            finite(pos.y, `Target y for '${pointId}'`);
            const coords = this.solver.setPointCoordinates(pointId, pos.x, pos.y);
            pinned.push({ xId: coords.xConstraintId, yId: coords.yConstraintId });
        }
        await this.solve();
        for (const { xId, yId } of pinned) {
            this.solver.removeConstraint(xId);
            this.solver.removeConstraint(yId);
        }
        await this.solve();
    }

    /** Add coincident joins where moved points land on existing points (1e-6). */
    private addLandingCoincidents(movedPointIds: Set<string>): void {
        const moved = [...movedPointIds];
        for (const movedId of moved) {
            const pos = this.getPointPosition(movedId);
            if (pos === undefined) {
                continue;
            }
            for (const primitive of this.primitives.values()) {
                if (primitive.type !== 'point' || primitive.id === movedId || movedPointIds.has(primitive.id)) {
                    continue;
                }
                const other = this.getPointPosition(primitive.id);
                if (other === undefined) {
                    continue;
                }
                if (Math.hypot(other.x - pos.x, other.y - pos.y) <= 1e-6) {
                    const coincidentId = this.nextId('coincident');
                    this.solver.addConstraintCoincident(coincidentId, movedId, primitive.id, { driving: true });
                    this.constraints.set(coincidentId, {
                        id: coincidentId,
                        kind: 'coincident',
                        targetIds: [movedId, primitive.id],
                        driving: true
                    });
                    break;
                }
            }
        }
    }

    /** In-place rigid translation/rotation core shared by move and rotate. */
    private async applyRigidTransformToSelection(transform: (p: Point2) => Point2, verb: string): Promise<TransformResult> {
        const ids = this.getSelection();
        if (ids.length === 0) {
            return { success: false, error: `${verb} needs at least one selected primitive` };
        }
        const closure = this.transformClosure(ids);
        if ('error' in closure) {
            return { success: false, error: closure.error };
        }
        const moves = new Map<string, Point2>();
        for (const pointId of closure.pointIds) {
            const pos = this.getPointPosition(pointId);
            if (pos === undefined) {
                return { success: false, error: `${verb} references unsolved geometry on '${pointId}'` };
            }
            moves.set(pointId, transform(pos));
        }
        this.dropTransformBlockers(closure.allIds, closure.pointIds);
        await this.applyPointMoves(moves);
        this.addLandingCoincidents(closure.pointIds);
        await this.commit([]);
        this.emitChange();
        return { success: true, movedPrimitiveIds: [...closure.allIds] };
    }

    private async applyRotationToSelection(center: Point2, angle: number): Promise<TransformResult> {
        const ids = this.getSelection();
        if (ids.length === 0) {
            return { success: false, error: 'Rotate needs at least one selected primitive' };
        }
        const closure = this.transformClosure(ids);
        if ('error' in closure) {
            return { success: false, error: closure.error };
        }
        const moves = new Map<string, Point2>();
        for (const pointId of closure.pointIds) {
            const pos = this.getPointPosition(pointId);
            if (pos === undefined) {
                return { success: false, error: `Rotate references unsolved geometry on '${pointId}'` };
            }
            moves.set(pointId, rotatePoint(pos, center, angle));
        }
        this.dropTransformBlockers(closure.allIds, closure.pointIds);
        // Rotation changes line orientation: drop axis locks on rotated lines.
        for (const [id, record] of [...this.constraints]) {
            if ((record.kind === 'horizontal' || record.kind === 'vertical') && closure.allIds.has(record.targetIds[0])) {
                this.removeConstraintInternal(id);
            }
        }
        await this.applyPointMoves(moves);
        for (const curveId of closure.curveIds) {
            const curve = this.primitives.get(curveId);
            if (curve?.type !== 'arc') {
                continue;
            }
            const solved = this.solver.getPrimitive(curveId);
            const radius = solved?.type === 'arc' ? solved.radius : curve.radius;
            const startAngle = rotateAngle(curve.startAngle, angle);
            const endAngle = rotateAngle(curve.endAngle, angle);
            this.rebuildArcInPlace(curveId, curve.centerId, radius, startAngle, endAngle, curve.startId, curve.endId, curve.construction);
        }
        this.addLandingCoincidents(closure.pointIds);
        await this.commit([]);
        this.emitChange();
        return { success: true, movedPrimitiveIds: [...closure.allIds] };
    }

    private async applyScaleToIds(ids: string[], center: Point2, factor: number): Promise<TransformResult> {
        const closure = this.transformClosure(ids);
        if ('error' in closure) {
            return { success: false, error: closure.error };
        }
        const moves = new Map<string, Point2>();
        for (const pointId of closure.pointIds) {
            const pos = this.getPointPosition(pointId);
            if (pos === undefined) {
                return { success: false, error: `Scale references unsolved geometry on '${pointId}'` };
            }
            moves.set(pointId, scalePoint(pos, center, factor));
        }
        this.dropTransformBlockers(closure.allIds, closure.pointIds);
        await this.applyPointMoves(moves);
        for (const curveId of closure.curveIds) {
            const curve = this.primitives.get(curveId);
            if (curve?.type === 'circle') {
                const solved = this.solver.getPrimitive(curveId);
                const radius = (solved?.type === 'circle' ? solved.radius : curve.radius) * factor;
                const refs = [...this.constraints.values()].filter((record) => record.targetIds.includes(curveId));
                this.solver.removePrimitive(curveId);
                this.solver.addCircle(curveId, curve.centerId, radius, { construction: curve.construction });
                this.primitives.set(curveId, { ...curve, radius });
                for (const record of refs) {
                    if (record.kind === 'radius') {
                        if (typeof record.value === 'number') {
                            record.value = record.value * factor;
                            this.constraints.set(record.id, record);
                            const dimension = [...this.dimensions.values()].find((d) => d.constraintId === record.id);
                            if (dimension !== undefined && typeof dimension.value === 'number') {
                                dimension.value = dimension.value * factor;
                            }
                        } else {
                            this.removeConstraintInternal(record.id);
                            continue;
                        }
                    }
                    this.solver.removeConstraint(record.id);
                    this.replayConstraintRecord(record);
                }
            } else if (curve?.type === 'arc') {
                const solved = this.solver.getPrimitive(curveId);
                const radius = (solved?.type === 'arc' ? solved.radius : curve.radius) * factor;
                this.rebuildArcInPlace(
                    curveId,
                    curve.centerId,
                    radius,
                    curve.startAngle,
                    curve.endAngle,
                    curve.startId,
                    curve.endId,
                    curve.construction
                );
                for (const record of [...this.constraints.values()].filter((r) => r.targetIds.includes(curveId) && r.kind === 'radius')) {
                    if (typeof record.value === 'number') {
                        record.value = record.value * factor;
                        this.constraints.set(record.id, record);
                        const dimension = [...this.dimensions.values()].find((d) => d.constraintId === record.id);
                        if (dimension !== undefined && typeof dimension.value === 'number') {
                            dimension.value = dimension.value * factor;
                        }
                        this.solver.removeConstraint(record.id);
                        this.replayConstraintRecord(record);
                    } else {
                        this.removeConstraintInternal(record.id);
                    }
                }
            } else if (curve?.type === 'ellipse') {
                const solved = this.solver.getPrimitive(curveId);
                const radmin = (solved?.type === 'ellipse' ? solved.radmin : curve.radmin) * factor;
                const refs = [...this.constraints.values()].filter((record) => record.targetIds.includes(curveId));
                this.solver.removePrimitive(curveId);
                this.solver.addEllipse(curveId, curve.centerId, curve.focus1Id, radmin, { construction: curve.construction });
                this.primitives.set(curveId, { ...curve, radmin });
                for (const record of refs) {
                    this.solver.removeConstraint(record.id);
                    this.replayConstraintRecord(record);
                }
            }
        }
        for (const record of [...this.constraints.values()].filter((r) => r.kind === 'distance')) {
            if (record.targetIds.every((target) => closure.allIds.has(target)) && typeof record.value === 'number') {
                record.value = record.value * factor;
                this.constraints.set(record.id, record);
                const dimension = [...this.dimensions.values()].find((d) => d.constraintId === record.id);
                if (dimension !== undefined && typeof dimension.value === 'number') {
                    dimension.value = dimension.value * factor;
                }
                this.solver.removeConstraint(record.id);
                this.replayConstraintRecord(record);
            }
        }
        this.addLandingCoincidents(closure.pointIds);
        await this.commit([]);
        this.emitChange();
        return { success: true, movedPrimitiveIds: [...closure.allIds] };
    }

    /**
     * Copy the selection closure with a point transform and an optional arc
     * angle transform, remapping fully-internal constraints and dimensions.
     */
    private async copySelectionWithPointTransform(
        transform: (p: Point2) => Point2,
        transformArcAngles: ((startAngle: number, endAngle: number) => { startAngle: number; endAngle: number }) | undefined,
        verb: string
    ): Promise<TransformResult> {
        const ids = this.getSelection();
        if (ids.length === 0) {
            return { success: false, error: `${verb} needs at least one selected primitive` };
        }
        return this.copyIdsWithPointTransform(ids, transform, transformArcAngles, true);
    }

    /** Copy explicit ids (gestures use the selection; array/offset paths reuse this core). */
    private async copyIdsWithPointTransform(
        ids: string[],
        transform: (p: Point2) => Point2,
        transformArcAngles: ((startAngle: number, endAngle: number) => { startAngle: number; endAngle: number }) | undefined,
        remapConstraints: boolean
    ): Promise<TransformResult> {
        const closure = this.transformClosure(ids);
        if ('error' in closure) {
            return { success: false, error: closure.error };
        }
        const pointMap = new Map<string, string>();
        const addedPrimitiveIds: string[] = [];
        const positions = new Map<string, Point2>();
        for (const pointId of closure.pointIds) {
            const pos = this.getPointPosition(pointId);
            if (pos === undefined) {
                return { success: false, error: `Copy references unsolved geometry on '${pointId}'` };
            }
            positions.set(pointId, transform(pos));
        }
        const pointConstruction = new Map<string, boolean>();
        for (const pointId of closure.pointIds) {
            const original = this.primitives.get(pointId);
            pointConstruction.set(pointId, original?.construction ?? false);
        }
        // Points first so curves can reference the fresh ids.
        const orderedPoints = [...closure.pointIds].sort();
        for (const oldId of orderedPoints) {
            const pos = positions.get(oldId)!;
            const newId = this.nextId('point');
            this.addPointInternal(newId, pos.x, pos.y, pointConstruction.get(oldId) ?? false);
            pointMap.set(oldId, newId);
            addedPrimitiveIds.push(newId);
        }
        const curveRemap = new Map<string, string>();
        const orderedCurves = [...closure.curveIds].sort();
        for (const oldId of orderedCurves) {
            const original = this.primitives.get(oldId)!;
            const newId = this.nextId(oldId.split('-')[0] ?? 'curve');
            const construction = original.construction;
            if (original.type === 'line') {
                this.addLineInternal(newId, pointMap.get(original.p1Id)!, pointMap.get(original.p2Id)!, construction);
            } else if (original.type === 'circle') {
                const solved = this.solver.getPrimitive(oldId);
                const radius = solved?.type === 'circle' ? solved.radius : original.radius;
                this.addCircleInternal(newId, pointMap.get(original.centerId)!, radius, construction);
            } else if (original.type === 'arc') {
                const solved = this.solver.getPrimitive(oldId);
                const radius = solved?.type === 'arc' ? solved.radius : original.radius;
                const angles =
                    transformArcAngles !== undefined
                        ? transformArcAngles(original.startAngle, original.endAngle)
                        : { startAngle: original.startAngle, endAngle: original.endAngle };
                this.addArcInternal(
                    newId,
                    pointMap.get(original.centerId)!,
                    radius,
                    angles.startAngle,
                    angles.endAngle,
                    pointMap.get(original.startId)!,
                    pointMap.get(original.endId)!,
                    construction
                );
            } else if (original.type === 'ellipse') {
                const solved = this.solver.getPrimitive(oldId);
                const radmin = solved?.type === 'ellipse' ? solved.radmin : original.radmin;
                this.addEllipseInternal(newId, pointMap.get(original.centerId)!, pointMap.get(original.focus1Id)!, radmin, construction);
            } else if (original.type === 'bspline') {
                const poles = original.poleIds.map((poleId) => pointMap.get(poleId)!);
                this.addBSplineInternal(
                    newId,
                    poles,
                    [...original.weights],
                    [...original.knots],
                    [...original.mult],
                    original.degree,
                    construction
                );
            }
            curveRemap.set(oldId, newId);
            addedPrimitiveIds.push(newId);
        }
        const fullRemap = new Map<string, string>([...pointMap, ...curveRemap]);
        if (remapConstraints) {
            const internal = [...this.constraints.values()].filter((record) =>
                record.targetIds.every((target) => closure.allIds.has(target))
            );
            const constraintIdMap = new Map<string, string>();
            for (const record of internal) {
                const remappedTargets = record.targetIds.map((target) => fullRemap.get(target)!);
                const newId = this.nextId(record.kind);
                try {
                    this.applyConstraintRecordToSolver(newId, record.kind, remappedTargets, record);
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    return { success: false, error: message };
                }
                const stored: ConstraintRecord = { id: newId, kind: record.kind, targetIds: remappedTargets, driving: record.driving };
                if (record.value !== undefined) {
                    stored.value = record.value;
                }
                if (record.direction !== undefined) {
                    stored.direction = record.direction;
                }
                if (record.diameter !== undefined) {
                    stored.diameter = record.diameter;
                }
                this.constraints.set(newId, stored);
                constraintIdMap.set(record.id, newId);
            }
            // Remap dimensions whose constraint was duplicated above (mirrors
            // carbonCopyFrom: dimensions are UI metadata and never fail the copy).
            for (const dimension of [...this.dimensions.values()]) {
                const newConstraintId = constraintIdMap.get(dimension.constraintId);
                if (newConstraintId === undefined) {
                    continue;
                }
                if (!dimension.targetIds.every((target) => closure.allIds.has(target))) {
                    continue;
                }
                const remappedTargets = dimension.targetIds.map((target) => fullRemap.get(target)!);
                const newDimensionId = this.nextId('dimension');
                this.dimensions.set(newDimensionId, {
                    id: newDimensionId,
                    constraintId: newConstraintId,
                    kind: dimension.kind,
                    targetIds: remappedTargets,
                    driving: dimension.driving,
                    parameter: dimension.parameter,
                    value: dimension.value,
                    labelOffset: dimension.labelOffset === undefined ? undefined : [dimension.labelOffset[0], dimension.labelOffset[1]]
                });
            }
        }
        await this.commit([]);
        this.emitChange();
        return { success: true, addedPrimitiveIds };
    }

    /** Replay one stored constraint kind onto fresh target ids under a new id. */
    private applyConstraintRecordToSolver(
        newId: string,
        kind: ConstraintRecord['kind'],
        targetIds: string[],
        record: ConstraintRecord
    ): void {
        const driving = record.driving;
        switch (kind) {
            case 'coincident':
                this.solver.addConstraintCoincident(newId, targetIds[0], targetIds[1], { driving });
                break;
            case 'fix':
                this.solver.addConstraintFix(newId, targetIds[0]);
                break;
            case 'horizontal':
                this.solver.addConstraintHorizontal(newId, targetIds[0], { driving });
                break;
            case 'vertical':
                this.solver.addConstraintVertical(newId, targetIds[0], { driving });
                break;
            case 'parallel':
                this.solver.addConstraintParallel(newId, targetIds[0], targetIds[1], { driving });
                break;
            case 'perpendicular':
                this.solver.addConstraintPerpendicular(newId, targetIds[0], targetIds[1], { driving });
                break;
            case 'tangent':
                this.solver.addConstraintTangent(newId, targetIds[0], targetIds[1], { driving });
                break;
            case 'equal':
                this.solver.addConstraintEqual(newId, targetIds[0], targetIds[1], { driving });
                break;
            case 'concentric':
                this.solver.addConstraintConcentric(newId, targetIds[0], targetIds[1], { driving });
                break;
            case 'distance':
                this.solver.addConstraintDistance(newId, targetIds[0], targetIds[1], record.value as number | string, {
                    driving,
                    direction: record.direction ?? 'point-point'
                });
                break;
            case 'angle':
                this.solver.addConstraintAngle(newId, targetIds[0], targetIds[1], record.value as number | string, { driving });
                break;
            case 'radius':
                if (record.diameter) {
                    this.solver.addConstraintDiameter(newId, targetIds[0], record.value as number | string, { driving });
                } else {
                    this.solver.addConstraintRadius(newId, targetIds[0], record.value as number | string, { driving });
                }
                break;
            case 'symmetry':
                this.solver.addConstraintSymmetry(newId, targetIds[0], targetIds[1], targetIds[2], { driving });
                break;
            case 'pointOnObject':
                this.solver.addConstraintPointOnObject(newId, targetIds[0], targetIds[1], { driving });
                break;
        }
    }

    private async mirrorSelectionAcrossAxis(axisLineId: string, a: Point2, b: Point2): Promise<TransformResult> {
        const ids = this.getSelection().filter((id) => id !== axisLineId);
        if (ids.length === 0) {
            return { success: false, error: 'Mirror needs at least one selected primitive besides the axis line' };
        }
        const axis = axisAngle(a, b);
        const result = await this.copyIdsWithPointTransform(
            ids,
            (p) => mirrorPointAcrossLine(p, a, b),
            (startAngle, endAngle) => ({ startAngle: mirrorAngle(startAngle, axis), endAngle: mirrorAngle(endAngle, axis) }),
            true
        );
        if (!result.success) {
            return result;
        }
        // Pair each original point to its mirrored copy with a symmetry
        // constraint about the axis line. Curve pairing follows through the
        // shared points (point-level only for ellipse/B-spline scope).
        const closure = this.transformClosure(ids);
        if ('error' in closure) {
            return { success: false, error: closure.error };
        }
        const copies = result.addedPrimitiveIds ?? [];
        const orderedOriginals = [...closure.pointIds].sort();
        // copyIdsWithPointTransform creates points in sorted order, so the
        // first N added ids are the mirrored points in the same order.
        const mirroredPointIds = copies.slice(0, orderedOriginals.length);
        for (let index = 0; index < orderedOriginals.length; index++) {
            const symmetryId = this.nextId('symmetry');
            try {
                this.solver.addConstraintSymmetry(symmetryId, orderedOriginals[index], mirroredPointIds[index], axisLineId, {
                    driving: true
                });
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return { success: false, error: message };
            }
            this.constraints.set(symmetryId, {
                id: symmetryId,
                kind: 'symmetry',
                targetIds: [orderedOriginals[index], mirroredPointIds[index], axisLineId],
                driving: true
            });
        }
        await this.commit([]);
        this.emitChange();
        return result;
    }

    private async applyRectangularArray(ids: string[], dx: number, dy: number, rows: number, cols: number): Promise<TransformResult> {
        const closure = this.transformClosure(ids);
        if ('error' in closure) {
            return { success: false, error: closure.error };
        }
        const addedPrimitiveIds: string[] = [];
        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
                if (row === 0 && col === 0) {
                    continue;
                }
                const vector = { x: col * dx, y: row * dy };
                const result = await this.copyIdsWithPointTransform(ids, (p) => translatePoint(p, vector), undefined, false);
                if (!result.success) {
                    return result;
                }
                addedPrimitiveIds.push(...(result.addedPrimitiveIds ?? []));
            }
        }
        return { success: true, addedPrimitiveIds };
    }

    private async applyOffsetWire(ids: string[], distance: number, autoTrim: boolean): Promise<TransformResult> {
        const movedPrimitiveIds: string[] = [];
        // Snapshot pre-offset line endpoints when trimming: sequential
        // endpoint moves would otherwise drag already-offset neighbors off
        // their offset lines, so corners join at analytic intersections.
        const lineSnapshot = new Map<string, { a: Point2; b: Point2; p1Id: string; p2Id: string }>();
        if (autoTrim) {
            for (const id of ids) {
                const primitive = this.primitives.get(id);
                if (primitive === undefined) {
                    return { success: false, error: `Unknown primitive '${id}'` };
                }
                if (primitive.type !== 'line') {
                    continue;
                }
                const a = this.getPointPosition(primitive.p1Id);
                const b = this.getPointPosition(primitive.p2Id);
                if (a === undefined || b === undefined) {
                    return { success: false, error: `Offset references unsolved geometry on '${id}'` };
                }
                lineSnapshot.set(id, { a, b, p1Id: primitive.p1Id, p2Id: primitive.p2Id });
            }
        }
        for (const id of ids) {
            const primitive = this.primitives.get(id);
            if (primitive === undefined) {
                return { success: false, error: `Unknown primitive '${id}'` };
            }
            if (primitive.type === 'line') {
                // With auto-trim the line endpoints land in joinOffsetLineCorners
                // below; without it each line moves independently as before.
                if (autoTrim) {
                    movedPrimitiveIds.push(id);
                    continue;
                }
                const a = this.getPointPosition(primitive.p1Id);
                const b = this.getPointPosition(primitive.p2Id);
                if (a === undefined || b === undefined) {
                    return { success: false, error: `Offset references unsolved geometry on '${id}'` };
                }
                const shifted = offsetLinePoints(a, b, distance);
                await this.movePointTo(primitive.p1Id, shifted.a);
                await this.movePointTo(primitive.p2Id, shifted.b);
                this.pruneDetachedPointOnObjects(id);
                movedPrimitiveIds.push(id);
            } else if (primitive.type === 'circle') {
                const frame = this.circleFrame(id);
                if (frame === undefined) {
                    return { success: false, error: `Offset references unsolved geometry on '${id}'` };
                }
                const radius = frame.radius + distance;
                if (!(radius > 1e-9)) {
                    return { success: false, error: `Offset distance ${distance} collapses circle '${id}' (radius ${frame.radius})` };
                }
                const refs = [...this.constraints.values()].filter((record) => record.targetIds.includes(id));
                this.solver.removePrimitive(id);
                this.solver.addCircle(id, primitive.centerId, radius, { construction: primitive.construction });
                this.primitives.set(id, { ...primitive, radius });
                for (const record of refs) {
                    if (record.kind === 'radius') {
                        this.removeConstraintInternal(record.id);
                        continue;
                    }
                    this.solver.removeConstraint(record.id);
                    this.replayConstraintRecord(record);
                }
                this.pruneDetachedPointOnObjects(id);
                movedPrimitiveIds.push(id);
            } else if (primitive.type === 'arc') {
                const frame = this.arcFrame(id);
                if (frame === undefined) {
                    return { success: false, error: `Offset references unsolved geometry on '${id}'` };
                }
                const radius = frame.radius + distance;
                if (!(radius > 1e-9)) {
                    return { success: false, error: `Offset distance ${distance} collapses arc '${id}' (radius ${frame.radius})` };
                }
                const startPt = arcPointAt(frame.center, radius, frame.startAngle);
                const endPt = arcPointAt(frame.center, radius, frame.endAngle);
                const startCoords = this.solver.setPointCoordinates(primitive.startId, startPt.x, startPt.y);
                const endCoords = this.solver.setPointCoordinates(primitive.endId, endPt.x, endPt.y);
                this.rebuildArcInPlace(
                    id,
                    primitive.centerId,
                    radius,
                    frame.startAngle,
                    frame.endAngle,
                    primitive.startId,
                    primitive.endId,
                    primitive.construction
                );
                await this.solve();
                this.solver.removeConstraint(startCoords.xConstraintId);
                this.solver.removeConstraint(startCoords.yConstraintId);
                this.solver.removeConstraint(endCoords.xConstraintId);
                this.solver.removeConstraint(endCoords.yConstraintId);
                await this.solve();
                for (const [constraintId, record] of [...this.constraints]) {
                    if (record.targetIds.includes(id) && record.kind === 'radius') {
                        this.removeConstraintInternal(constraintId);
                    }
                }
                this.pruneDetachedPointOnObjects(id);
                movedPrimitiveIds.push(id);
            } else if (primitive.type === 'point') {
                return { success: false, error: `Offset supports lines, circles, and arcs — '${id}' is a point` };
            } else if (primitive.type === 'ellipse') {
                return { success: false, error: `Offset supports lines, circles, and arcs — ellipses carry point-level constraints only` };
            } else {
                return { success: false, error: `Offset supports lines, circles, and arcs — B-splines carry point-level constraints only` };
            }
        }
        if (autoTrim) {
            await this.joinOffsetLineCorners(ids, lineSnapshot, distance);
        }
        await this.commit([]);
        this.emitChange();
        return { success: true, movedPrimitiveIds };
    }

    /**
     * Miter-join offset lines at their shared corners (offset auto-trim).
     *
     * Keep-rule: every sketch point used exclusively by offset lines lands
     * exactly once. A point shared by exactly two offset lines moves to the
     * intersection of the two analytic offset lines (trims the overlap past
     * the corner or closes the gap); a parallel pair (or an intersection
     * beyond the 1e6 robustness cap, which would explode the solver) falls
     * back to the first offset line's endpoint. Points used by a single
     * offset line take that line's endpoint; junctions of three or more
     * lines take the first line's endpoint. Points also referenced by any
     * non-offset primitive (arcs, circles, un-offset lines, …) are never
     * written, so auto-trim stays connected to foreign geometry instead of
     * dragging it. Nothing is ever deleted: every offset line keeps both
     * endpoints.
     */
    private async joinOffsetLineCorners(
        ids: string[],
        lineSnapshot: Map<string, { a: Point2; b: Point2; p1Id: string; p2Id: string }>,
        distance: number
    ): Promise<void> {
        const offsetLineIds = new Set<string>();
        const ends = new Map<string, { p1: Point2; p2: Point2 }>();
        for (const id of ids) {
            const snap = lineSnapshot.get(id);
            if (snap === undefined || offsetLineIds.has(id)) {
                continue;
            }
            offsetLineIds.add(id);
            const shifted = offsetLinePoints(snap.a, snap.b, distance);
            ends.set(id, { p1: shifted.a, p2: shifted.b });
        }
        const cornerOf = (id: string, pointId: string): Point2 => {
            const snap = lineSnapshot.get(id);
            const end = ends.get(id);
            if (snap === undefined || end === undefined) {
                throw new Error(`Offset trim references missing line '${id}'`);
            }
            return pointId === snap.p1Id ? end.p1 : end.p2;
        };
        const preCorner = (id: string, pointId: string): Point2 => {
            const snap = lineSnapshot.get(id);
            if (snap === undefined) {
                throw new Error(`Offset trim references missing line '${id}'`);
            }
            return pointId === snap.p1Id ? snap.a : snap.b;
        };
        const written = new Set<string>();
        for (const id of offsetLineIds) {
            const snap = lineSnapshot.get(id);
            if (snap === undefined) {
                continue;
            }
            for (const pointId of [snap.p1Id, snap.p2Id]) {
                if (written.has(pointId)) {
                    continue;
                }
                const users = this.offsetLineUsers(pointId, offsetLineIds);
                if (!users.exclusive) {
                    continue;
                }
                let target: Point2;
                if (users.lines.length === 2) {
                    const [first, second] = users.lines;
                    const f = ends.get(first);
                    const s = ends.get(second);
                    const hit = f === undefined || s === undefined ? undefined : lineLineIntersection(f.p1, f.p2, s.p1, s.p2);
                    const before = preCorner(first, pointId);
                    if (
                        hit !== undefined &&
                        Number.isFinite(hit.x) &&
                        Number.isFinite(hit.y) &&
                        Math.hypot(hit.x - before.x, hit.y - before.y) <= 1e6
                    ) {
                        target = hit;
                    } else {
                        target = cornerOf(first, pointId);
                    }
                } else {
                    target = cornerOf(users.lines[0], pointId);
                }
                await this.movePointTo(pointId, target);
                written.add(pointId);
            }
            this.pruneDetachedPointOnObjects(id);
        }
    }

    /** Offset lines (subset of `offsetLineIds`) referencing a point, plus exclusivity. */
    private offsetLineUsers(pointId: string, offsetLineIds: Set<string>): { exclusive: boolean; lines: string[] } {
        const lines: string[] = [];
        for (const [id, primitive] of this.primitives) {
            if (primitive.type === 'point') {
                continue;
            }
            let uses = false;
            if (primitive.type === 'line') {
                uses = primitive.p1Id === pointId || primitive.p2Id === pointId;
            } else if (primitive.type === 'circle') {
                uses = primitive.centerId === pointId;
            } else if (primitive.type === 'arc') {
                uses = primitive.centerId === pointId || primitive.startId === pointId || primitive.endId === pointId;
            } else if (primitive.type === 'ellipse') {
                uses = primitive.centerId === pointId || primitive.focus1Id === pointId;
            } else {
                uses = primitive.poleIds.includes(pointId);
            }
            if (!uses) {
                continue;
            }
            if (primitive.type !== 'line' || !offsetLineIds.has(id)) {
                return { exclusive: false, lines: [] };
            }
            if (!lines.includes(id)) {
                lines.push(id);
            }
        }
        return { exclusive: true, lines };
    }

    private async doTrim(
        raw: Point2,
        modifiers?: { disableSnap?: boolean }
    ): Promise<{ result: EditCurveResult; auto: AutoConstraintFeedback[] }> {
        const auto: AutoConstraintFeedback[] = [];
        const snapped = this.applySnap(raw, modifiers?.disableSnap);
        const hit = this.findNearestCurve(snapped.point, TRIM_CURVE_TARGETS, this.pickTolerance());
        if (hit === undefined) {
            return { result: { success: false, error: this.curveTargetError(snapped.point, 'Trim') }, auto };
        }
        try {
            if (hit.kind === 'line') {
                return { result: await this.trimLine(hit.id, snapped.point, auto), auto };
            }
            if (hit.kind === 'circle') {
                return { result: await this.trimCircle(hit.id, snapped.point, auto), auto };
            }
            return { result: await this.trimArc(hit.id, snapped.point, auto), auto };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { result: { success: false, error: message }, auto };
        }
    }

    private async doExtend(
        raw: Point2,
        modifiers?: { disableSnap?: boolean }
    ): Promise<{ result: EditCurveResult; auto: AutoConstraintFeedback[] }> {
        const auto: AutoConstraintFeedback[] = [];
        const snapped = this.applySnap(raw, modifiers?.disableSnap);
        const click = snapped.point;
        const tol = this.pickTolerance();
        let picked: { curveId: string; kind: 'line' | 'arc'; endId: string } | undefined;
        if (snapped.kind === 'endpoint' && snapped.pointId !== undefined) {
            picked = this.ownerEndOf(snapped.pointId);
        }
        if (picked === undefined) {
            picked = this.findNearestEnd(click, tol);
        }
        if (picked === undefined) {
            return { result: { success: false, error: 'Extend found no line or arc end near the click' }, auto };
        }
        try {
            return { result: await this.extendEnd(picked.curveId, picked.kind, picked.endId, auto), auto };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { result: { success: false, error: message }, auto };
        }
    }

    private async doSplit(
        raw: Point2,
        modifiers?: { disableSnap?: boolean }
    ): Promise<{ result: EditCurveResult; auto: AutoConstraintFeedback[] }> {
        const auto: AutoConstraintFeedback[] = [];
        const snapped = this.applySnap(raw, modifiers?.disableSnap);
        const hit = this.findNearestCurve(snapped.point, TRIM_CURVE_TARGETS, this.pickTolerance());
        if (hit === undefined) {
            return { result: { success: false, error: this.curveTargetError(snapped.point, 'Split') }, auto };
        }
        try {
            if (hit.kind === 'line') {
                return { result: await this.splitLine(hit.id, snapped.point, auto), auto };
            }
            if (hit.kind === 'circle') {
                return { result: await this.splitCircle(hit.id, snapped.point, auto), auto };
            }
            return { result: await this.splitArc(hit.id, snapped.point, auto), auto };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { result: { success: false, error: message }, auto };
        }
    }

    /** Snap-scaled pick tolerance in model units (applies even with snapping off). */
    private pickTolerance(): number {
        return this.snapConfig.radius * (this.snapRadiusPx / SketchSession.DEFAULT_SNAP_RADIUS_PX);
    }

    private curveDistance(kind: 'line' | 'circle' | 'arc', id: string, point: Point2): number | undefined {
        if (kind === 'line') {
            const line = this.primitives.get(id);
            if (line?.type !== 'line') {
                return undefined;
            }
            const a = this.getPointPosition(line.p1Id);
            const b = this.getPointPosition(line.p2Id);
            if (a === undefined || b === undefined) {
                return undefined;
            }
            return pointToSegmentDistance(point, a, b);
        }
        const frame = kind === 'circle' ? this.circleFrame(id) : this.arcFrame(id);
        if (frame === undefined) {
            return undefined;
        }
        const radial = Math.abs(Math.hypot(point.x - frame.center.x, point.y - frame.center.y) - frame.radius);
        if (kind === 'circle') {
            return radial;
        }
        const arcSpan = this.arcFrame(id);
        if (arcSpan === undefined) {
            return undefined;
        }
        if (isAngleOnArc(angleOfPoint(point, arcSpan.center), arcSpan.startAngle, arcSpan.endAngle)) {
            return radial;
        }
        const arc = this.primitives.get(id);
        if (arc?.type !== 'arc') {
            return undefined;
        }
        const s = this.getPointPosition(arc.startId);
        const e = this.getPointPosition(arc.endId);
        if (s === undefined || e === undefined) {
            return undefined;
        }
        return Math.min(Math.hypot(point.x - s.x, point.y - s.y), Math.hypot(point.x - e.x, point.y - e.y));
    }

    private findNearestCurve(
        point: Point2,
        allowed: ReadonlySet<'line' | 'circle' | 'arc'>,
        maxDist: number
    ): { id: string; kind: 'line' | 'circle' | 'arc' } | undefined {
        let best: { id: string; kind: 'line' | 'circle' | 'arc'; distance: number } | undefined;
        for (const [id, primitive] of this.primitives) {
            if (primitive.type !== 'line' && primitive.type !== 'circle' && primitive.type !== 'arc') {
                continue;
            }
            if (!allowed.has(primitive.type)) {
                continue;
            }
            const distance = this.curveDistance(primitive.type, id, point);
            if (distance === undefined || distance > maxDist) {
                continue;
            }
            if (best === undefined || distance < best.distance) {
                best = { id, kind: primitive.type, distance };
            }
        }
        return best === undefined ? undefined : { id: best.id, kind: best.kind };
    }

    /**
     * True when the click is near an ellipse/B-spline (which trim/extend/split
     * never edit: those curves carry point-level constraints only).
     */
    private nearUnsupportedCurve(point: Point2, maxDist: number): 'ellipse' | 'bspline' | undefined {
        for (const primitive of this.primitives.values()) {
            if (primitive.type === 'ellipse') {
                const center = this.getPointPosition(primitive.centerId);
                const focus1 = this.getPointPosition(primitive.focus1Id);
                if (center === undefined || focus1 === undefined) {
                    continue;
                }
                const solved = this.solver.getPrimitive(primitive.id);
                const radmin = solved?.type === 'ellipse' ? solved.radmin : primitive.radmin;
                const nearest = nearestPolylinePoint(point, sharedEllipsePolyline(center, focus1, radmin));
                if (nearest !== undefined && nearest.distance <= maxDist) {
                    return 'ellipse';
                }
            } else if (primitive.type === 'bspline') {
                const poles: Point2[] = [];
                let resolved = true;
                for (const poleId of primitive.poleIds) {
                    const pos = this.getPointPosition(poleId);
                    if (pos === undefined) {
                        resolved = false;
                        break;
                    }
                    poles.push(pos);
                }
                if (!resolved) {
                    continue;
                }
                const nearest = nearestPolylinePoint(
                    point,
                    sharedBSplinePolyline(poles, primitive.knots, primitive.mult, primitive.degree)
                );
                if (nearest !== undefined && nearest.distance <= maxDist) {
                    return 'bspline';
                }
            }
        }
        return undefined;
    }

    private curveTargetError(point: Point2, verb: string): string {
        const bad = this.nearUnsupportedCurve(point, this.pickTolerance());
        if (bad === 'ellipse') {
            return `${verb} supports lines, circles, and arcs — ellipses carry point-level constraints only`;
        }
        if (bad === 'bspline') {
            return `${verb} supports lines, circles, and arcs — B-splines carry point-level constraints only`;
        }
        return `${verb} found no line, circle, or arc near the click`;
    }

    private circleFrame(id: string): { center: Point2; radius: number } | undefined {
        const primitive = this.primitives.get(id);
        if (primitive?.type !== 'circle') {
            return undefined;
        }
        const center = this.getPointPosition(primitive.centerId);
        if (center === undefined) {
            return undefined;
        }
        const solved = this.solver.getPrimitive(id);
        return { center, radius: solved?.type === 'circle' ? solved.radius : primitive.radius };
    }

    private arcFrame(id: string): { center: Point2; radius: number; startAngle: number; endAngle: number } | undefined {
        const primitive = this.primitives.get(id);
        if (primitive?.type !== 'arc') {
            return undefined;
        }
        const center = this.getPointPosition(primitive.centerId);
        if (center === undefined) {
            return undefined;
        }
        const solved = this.solver.getPrimitive(id);
        if (solved?.type === 'arc') {
            return { center, radius: solved.radius, startAngle: solved.startAngle, endAngle: solved.endAngle };
        }
        return { center, radius: primitive.radius, startAngle: primitive.startAngle, endAngle: primitive.endAngle };
    }

    /** Intersections of other curves with the infinite line through a/b, clipped per mode. */
    private lineTargetIntersections(targetId: string, a: Point2, b: Point2, ray?: { origin: Point2; dir: Point2 }): CurveIntersection[] {
        const hits: CurveIntersection[] = [];
        for (const [id, primitive] of this.primitives) {
            if (id === targetId) {
                continue;
            }
            if (primitive.type === 'line') {
                const c = this.getPointPosition(primitive.p1Id);
                const d = this.getPointPosition(primitive.p2Id);
                if (c === undefined || d === undefined) {
                    continue;
                }
                const hit = lineLineIntersection(a, b, c, d);
                if (hit === undefined) {
                    continue;
                }
                if (ray !== undefined) {
                    if ((hit.x - ray.origin.x) * ray.dir.x + (hit.y - ray.origin.y) * ray.dir.y <= 1e-9) {
                        continue;
                    }
                } else {
                    const t = segmentParameter(hit, a, b);
                    if (t < -1e-9 || t > 1 + 1e-9) {
                        continue;
                    }
                }
                const u = segmentParameter(hit, c, d);
                if (u < -1e-9 || u > 1 + 1e-9) {
                    continue;
                }
                hits.push({ point: hit, otherId: id });
            } else if (primitive.type === 'circle' || primitive.type === 'arc') {
                const frame = primitive.type === 'circle' ? this.circleFrame(id) : this.arcFrame(id);
                if (frame === undefined) {
                    continue;
                }
                for (const hit of lineCircleIntersections(a, b, frame.center, frame.radius)) {
                    if (ray !== undefined) {
                        if ((hit.x - ray.origin.x) * ray.dir.x + (hit.y - ray.origin.y) * ray.dir.y <= 1e-9) {
                            continue;
                        }
                    } else {
                        const t = segmentParameter(hit, a, b);
                        if (t < -1e-9 || t > 1 + 1e-9) {
                            continue;
                        }
                    }
                    if (primitive.type === 'arc') {
                        const arc = this.arcFrame(id);
                        if (arc === undefined || !isAngleOnArc(angleOfPoint(hit, arc.center), arc.startAngle, arc.endAngle)) {
                            continue;
                        }
                    }
                    hits.push({ point: hit, otherId: id });
                }
            }
        }
        return hits;
    }

    /** Intersections of other curves with a circle; optionally clipped to an arc span. */
    private circleTargetIntersections(
        targetId: string,
        center: Point2,
        radius: number,
        span?: { startAngle: number; endAngle: number }
    ): Array<CurveIntersection & { angle: number }> {
        const hits: Array<CurveIntersection & { angle: number }> = [];
        const accept = (hit: Point2, otherId: string): void => {
            const angle = angleOfPoint(hit, center);
            if (span !== undefined && !isAngleOnArc(angle, span.startAngle, span.endAngle)) {
                return;
            }
            hits.push({ point: hit, otherId, angle });
        };
        for (const [id, primitive] of this.primitives) {
            if (id === targetId) {
                continue;
            }
            if (primitive.type === 'line') {
                const a = this.getPointPosition(primitive.p1Id);
                const b = this.getPointPosition(primitive.p2Id);
                if (a === undefined || b === undefined) {
                    continue;
                }
                for (const hit of lineCircleIntersections(a, b, center, radius)) {
                    const t = segmentParameter(hit, a, b);
                    if (t < -1e-9 || t > 1 + 1e-9) {
                        continue;
                    }
                    accept(hit, id);
                }
            } else if (primitive.type === 'circle' || primitive.type === 'arc') {
                const frame = primitive.type === 'circle' ? this.circleFrame(id) : this.arcFrame(id);
                if (frame === undefined) {
                    continue;
                }
                for (const hit of circleCircleIntersections(center, radius, frame.center, frame.radius)) {
                    if (primitive.type === 'arc') {
                        const arc = this.arcFrame(id);
                        if (arc === undefined || !isAngleOnArc(angleOfPoint(hit, arc.center), arc.startAngle, arc.endAngle)) {
                            continue;
                        }
                    }
                    accept(hit, id);
                }
            }
        }
        return hits;
    }

    /** Forward-ray intersections with every curve except the excluded one. */
    private castRay(origin: Point2, dir: Point2, excludeId: string): CurveIntersection[] {
        const far = { x: origin.x + dir.x, y: origin.y + dir.y };
        const hits: CurveIntersection[] = [];
        for (const [id, primitive] of this.primitives) {
            if (id === excludeId) {
                continue;
            }
            if (primitive.type === 'line') {
                const a = this.getPointPosition(primitive.p1Id);
                const b = this.getPointPosition(primitive.p2Id);
                if (a === undefined || b === undefined) {
                    continue;
                }
                const hit = lineLineIntersection(origin, far, a, b);
                if (hit === undefined) {
                    continue;
                }
                if ((hit.x - origin.x) * dir.x + (hit.y - origin.y) * dir.y <= 1e-9) {
                    continue;
                }
                const u = segmentParameter(hit, a, b);
                if (u < -1e-9 || u > 1 + 1e-9) {
                    continue;
                }
                hits.push({ point: hit, otherId: id });
            } else if (primitive.type === 'circle' || primitive.type === 'arc') {
                const frame = primitive.type === 'circle' ? this.circleFrame(id) : this.arcFrame(id);
                if (frame === undefined) {
                    continue;
                }
                for (const hit of lineCircleIntersections(origin, far, frame.center, frame.radius)) {
                    if ((hit.x - origin.x) * dir.x + (hit.y - origin.y) * dir.y <= 1e-9) {
                        continue;
                    }
                    if (primitive.type === 'arc') {
                        const arc = this.arcFrame(id);
                        if (arc === undefined || !isAngleOnArc(angleOfPoint(hit, arc.center), arc.startAngle, arc.endAngle)) {
                            continue;
                        }
                    }
                    hits.push({ point: hit, otherId: id });
                }
            }
        }
        hits.sort(
            (x, y) => Math.hypot(x.point.x - origin.x, x.point.y - origin.y) - Math.hypot(y.point.x - origin.x, y.point.y - origin.y)
        );
        return hits;
    }

    /** Permanently move a point, letting the solver reconcile dependents. */
    private async movePointTo(pointId: string, pos: Point2): Promise<void> {
        finite(pos.x, 'Target x');
        finite(pos.y, 'Target y');
        const coords = this.solver.setPointCoordinates(pointId, pos.x, pos.y);
        await this.solve();
        this.solver.removeConstraint(coords.xConstraintId);
        this.solver.removeConstraint(coords.yConstraintId);
        await this.solve();
    }

    /**
     * Trim-endpoint hygiene: anchor the moved end at the intersection with a
     * coincident constraint, creating a point-on-object anchor on the cutting
     * curve when no point exists there yet.
     */
    private addTrimEndpointHygiene(movedEndId: string, hit: CurveIntersection, auto: AutoConstraintFeedback[]): string {
        let anchorId: string | undefined;
        for (const primitive of this.primitives.values()) {
            if (primitive.type !== 'point' || primitive.id === movedEndId) {
                continue;
            }
            const pos = this.getPointPosition(primitive.id);
            if (pos !== undefined && Math.hypot(pos.x - hit.point.x, pos.y - hit.point.y) <= 1e-6) {
                anchorId = primitive.id;
                break;
            }
        }
        if (anchorId === undefined) {
            anchorId = this.nextId('point');
            this.addPointInternal(anchorId, hit.point.x, hit.point.y, false);
            const pointOnObjectId = this.nextId('point-on-object');
            this.solver.addConstraintPointOnObject(pointOnObjectId, anchorId, hit.otherId, { driving: true });
            this.constraints.set(pointOnObjectId, {
                id: pointOnObjectId,
                kind: 'pointOnObject',
                targetIds: [anchorId, hit.otherId],
                driving: true
            });
            auto.push({ kind: 'pointOnObject', ids: [pointOnObjectId] });
        }
        const coincidentId = this.nextId('coincident');
        this.solver.addConstraintCoincident(coincidentId, movedEndId, anchorId, { driving: true });
        this.constraints.set(coincidentId, { id: coincidentId, kind: 'coincident', targetIds: [movedEndId, anchorId], driving: true });
        auto.push({ kind: 'coincident', ids: [coincidentId] });
        return anchorId;
    }

    /** Drop point-on-object constraints whose point no longer lies on the curve. */
    private pruneDetachedPointOnObjects(curveId: string): void {
        for (const [id, record] of [...this.constraints]) {
            if (record.kind !== 'pointOnObject' || record.targetIds[1] !== curveId) {
                continue;
            }
            const pos = this.getPointPosition(record.targetIds[0]);
            if (pos === undefined) {
                continue;
            }
            if (!this.pointOnCurve(pos, curveId, 1e-6)) {
                this.removeConstraintInternal(id);
            }
        }
    }

    private pointOnCurve(pos: Point2, curveId: string, tolerance: number): boolean {
        const primitive = this.primitives.get(curveId);
        if (primitive?.type === 'line') {
            const a = this.getPointPosition(primitive.p1Id);
            const b = this.getPointPosition(primitive.p2Id);
            if (a === undefined || b === undefined) {
                return true;
            }
            return pointToSegmentDistance(pos, a, b) <= tolerance;
        }
        if (primitive?.type === 'circle') {
            const frame = this.circleFrame(curveId);
            if (frame === undefined) {
                return true;
            }
            return Math.abs(Math.hypot(pos.x - frame.center.x, pos.y - frame.center.y) - frame.radius) <= tolerance;
        }
        if (primitive?.type === 'arc') {
            const frame = this.arcFrame(curveId);
            if (frame === undefined) {
                return true;
            }
            if (Math.abs(Math.hypot(pos.x - frame.center.x, pos.y - frame.center.y) - frame.radius) > tolerance) {
                return false;
            }
            return isAngleOnArc(angleOfPoint(pos, frame.center), frame.startAngle, frame.endAngle, 1e-6);
        }
        return true;
    }

    /** Rebuild an arc in place (same id) and replay every constraint referencing it. */
    private rebuildArcInPlace(
        arcId: string,
        centerId: string,
        radius: number,
        startAngle: number,
        endAngle: number,
        startId: string,
        endId: string,
        construction: boolean
    ): void {
        const refs = [...this.constraints.values()].filter((record) => record.targetIds.includes(arcId));
        this.solver.removePrimitive(arcId);
        this.solver.addArc(arcId, centerId, radius, startAngle, endAngle, startId, endId, { construction });
        this.primitives.set(arcId, { type: 'arc', id: arcId, centerId, radius, startAngle, endAngle, startId, endId, construction });
        for (const record of refs) {
            this.solver.removeConstraint(record.id);
            this.replayConstraintRecord(record);
        }
    }

    private async trimLine(lineId: string, click: Point2, auto: AutoConstraintFeedback[]): Promise<EditCurveResult> {
        const line = this.primitives.get(lineId);
        if (line?.type !== 'line') {
            return { success: false, error: `Trim needs a line, got '${lineId}'` };
        }
        const a = this.getPointPosition(line.p1Id);
        const b = this.getPointPosition(line.p2Id);
        if (a === undefined || b === undefined) {
            return { success: false, error: `Trim references unsolved geometry on '${lineId}'` };
        }
        const hits = this.lineTargetIntersections(lineId, a, b);
        if (hits.length === 0) {
            return { success: false, error: `Trim found no intersection with '${lineId}' — nothing to clip` };
        }
        hits.sort((x, y) => Math.hypot(x.point.x - click.x, x.point.y - click.y) - Math.hypot(y.point.x - click.x, y.point.y - click.y));
        const hit = hits[0];
        const moveId = Math.hypot(click.x - a.x, click.y - a.y) <= Math.hypot(click.x - b.x, click.y - b.y) ? line.p1Id : line.p2Id;
        const oldPos = moveId === line.p1Id ? a : b;
        let pointId: string | undefined;
        if (Math.hypot(oldPos.x - hit.point.x, oldPos.y - hit.point.y) > 1e-9) {
            await this.movePointTo(moveId, hit.point);
            this.pruneDetachedPointOnObjects(lineId);
            pointId = this.addTrimEndpointHygiene(moveId, hit, auto);
        }
        await this.commit(auto);
        return { success: true, targetId: lineId, pointId, newIds: [lineId] };
    }

    private async trimCircle(circleId: string, click: Point2, auto: AutoConstraintFeedback[]): Promise<EditCurveResult> {
        const circle = this.primitives.get(circleId);
        if (circle?.type !== 'circle') {
            return { success: false, error: `Trim needs a circle, got '${circleId}'` };
        }
        const frame = this.circleFrame(circleId);
        if (frame === undefined) {
            return { success: false, error: `Trim references unsolved geometry on '${circleId}'` };
        }
        const hits = this.circleTargetIntersections(circleId, frame.center, frame.radius);
        if (hits.length === 0) {
            return { success: false, error: `Trim found no intersection with '${circleId}' — nothing to clip` };
        }
        if (hits.length === 1) {
            return { success: false, error: `Trim needs at least two intersections to open '${circleId}' (found one)` };
        }
        const twoPi = 2 * Math.PI;
        const sorted = [...hits].sort((x, y) => (((x.angle % twoPi) + twoPi) % twoPi) - (((y.angle % twoPi) + twoPi) % twoPi));
        const clickAngle = angleOfPoint(click, frame.center);
        let bracket = 0;
        for (let i = 0; i < sorted.length; i++) {
            const a0 = ((sorted[i].angle % twoPi) + twoPi) % twoPi;
            const a1 = ((sorted[(i + 1) % sorted.length].angle % twoPi) + twoPi) % twoPi;
            let span = (a1 - a0) % twoPi;
            if (span < 0) {
                span += twoPi;
            }
            let d = (clickAngle - a0) % twoPi;
            if (d < 0) {
                d += twoPi;
            }
            if (d < span) {
                bracket = i;
                break;
            }
        }
        const from = sorted[bracket];
        const to = sorted[(bracket + 1) % sorted.length];
        const fromAngle = ((from.angle % twoPi) + twoPi) % twoPi;
        let toAngle = ((to.angle % twoPi) + twoPi) % twoPi;
        if (toAngle <= fromAngle) {
            toAngle += twoPi;
        }
        // The kept arc runs from the next intersection around to the previous one.
        const startPt = arcPointAt(frame.center, frame.radius, toAngle);
        const endPt = arcPointAt(frame.center, frame.radius, fromAngle);
        const startId = this.nextId('point');
        const endId = this.nextId('point');
        this.addPointInternal(startId, startPt.x, startPt.y, circle.construction);
        this.addPointInternal(endId, endPt.x, endPt.y, circle.construction);
        for (const [id, record] of [...this.constraints]) {
            if (record.kind === 'pointOnObject' && record.targetIds[1] === circleId) {
                const pos = this.getPointPosition(record.targetIds[0]);
                if (pos !== undefined && !isAngleOnArc(angleOfPoint(pos, frame.center), toAngle, fromAngle + twoPi, 1e-6)) {
                    this.removeConstraintInternal(id);
                }
            }
        }
        const refs = [...this.constraints.values()].filter((record) => record.targetIds.includes(circleId));
        this.solver.removePrimitive(circleId);
        this.solver.addArc(circleId, circle.centerId, frame.radius, toAngle, fromAngle + twoPi, startId, endId, {
            construction: circle.construction
        });
        this.primitives.set(circleId, {
            type: 'arc',
            id: circleId,
            centerId: circle.centerId,
            radius: frame.radius,
            startAngle: toAngle,
            endAngle: fromAngle + twoPi,
            startId,
            endId,
            construction: circle.construction
        });
        for (const record of refs) {
            this.solver.removeConstraint(record.id);
            this.replayConstraintRecord(record);
        }
        this.addTrimEndpointHygiene(startId, { point: startPt, otherId: to.otherId }, auto);
        this.addTrimEndpointHygiene(endId, { point: endPt, otherId: from.otherId }, auto);
        this.pruneDetachedPointOnObjects(circleId);
        await this.commit(auto);
        return { success: true, targetId: circleId, newIds: [circleId] };
    }

    private async trimArc(arcId: string, click: Point2, auto: AutoConstraintFeedback[]): Promise<EditCurveResult> {
        const arc = this.primitives.get(arcId);
        if (arc?.type !== 'arc') {
            return { success: false, error: `Trim needs an arc, got '${arcId}'` };
        }
        const frame = this.arcFrame(arcId);
        const startPos = this.getPointPosition(arc.startId);
        const endPos = this.getPointPosition(arc.endId);
        if (frame === undefined || startPos === undefined || endPos === undefined) {
            return { success: false, error: `Trim references unsolved geometry on '${arcId}'` };
        }
        const hits = this.circleTargetIntersections(arcId, frame.center, frame.radius, {
            startAngle: frame.startAngle,
            endAngle: frame.endAngle
        });
        if (hits.length === 0) {
            return { success: false, error: `Trim found no intersection with '${arcId}' — nothing to clip` };
        }
        hits.sort((x, y) => Math.hypot(x.point.x - click.x, x.point.y - click.y) - Math.hypot(y.point.x - click.x, y.point.y - click.y));
        const hit = hits[0];
        const moveStart = Math.hypot(click.x - startPos.x, click.y - startPos.y) <= Math.hypot(click.x - endPos.x, click.y - endPos.y);
        const moveId = moveStart ? arc.startId : arc.endId;
        const oldPos = moveStart ? startPos : endPos;
        const sweep = frame.endAngle - frame.startAngle;
        let hitAngle = hit.angle;
        if (sweep >= 0) {
            let d = (hitAngle - frame.startAngle) % (2 * Math.PI);
            if (d < 0) {
                d += 2 * Math.PI;
            }
            hitAngle = frame.startAngle + d;
        } else {
            let d = (frame.startAngle - hitAngle) % (2 * Math.PI);
            if (d < 0) {
                d += 2 * Math.PI;
            }
            hitAngle = frame.startAngle - d;
        }
        const newStart = moveStart ? hitAngle : frame.startAngle;
        const newEnd = moveStart ? frame.endAngle : hitAngle;
        const newRadius = Math.hypot(hit.point.x - frame.center.x, hit.point.y - frame.center.y);
        for (const [id, record] of [...this.constraints]) {
            if (record.kind === 'pointOnObject' && record.targetIds[1] === arcId) {
                const pos = this.getPointPosition(record.targetIds[0]);
                if (pos !== undefined && !isAngleOnArc(angleOfPoint(pos, frame.center), newStart, newEnd, 1e-6)) {
                    this.removeConstraintInternal(id);
                }
            }
        }
        const coords = this.solver.setPointCoordinates(moveId, hit.point.x, hit.point.y);
        this.rebuildArcInPlace(arcId, arc.centerId, newRadius, newStart, newEnd, arc.startId, arc.endId, arc.construction);
        await this.solve();
        this.solver.removeConstraint(coords.xConstraintId);
        this.solver.removeConstraint(coords.yConstraintId);
        await this.solve();
        let pointId: string | undefined;
        if (Math.hypot(oldPos.x - hit.point.x, oldPos.y - hit.point.y) > 1e-9) {
            pointId = this.addTrimEndpointHygiene(moveId, hit, auto);
        }
        this.pruneDetachedPointOnObjects(arcId);
        await this.commit(auto);
        return { success: true, targetId: arcId, pointId, newIds: [arcId] };
    }

    /** Line/arc end nearest the click within tolerance. */
    private findNearestEnd(click: Point2, tolerance: number): { curveId: string; kind: 'line' | 'arc'; endId: string } | undefined {
        let best: { curveId: string; kind: 'line' | 'arc'; endId: string; distance: number } | undefined;
        const consider = (curveId: string, kind: 'line' | 'arc', endId: string): void => {
            const pos = this.getPointPosition(endId);
            if (pos === undefined) {
                return;
            }
            const distance = Math.hypot(pos.x - click.x, pos.y - click.y);
            if (distance <= tolerance && (best === undefined || distance < best.distance)) {
                best = { curveId, kind, endId, distance };
            }
        };
        for (const [id, primitive] of this.primitives) {
            if (primitive.type === 'line') {
                consider(id, 'line', primitive.p1Id);
                consider(id, 'line', primitive.p2Id);
            } else if (primitive.type === 'arc') {
                consider(id, 'arc', primitive.startId);
                consider(id, 'arc', primitive.endId);
            }
        }
        return best === undefined ? undefined : { curveId: best.curveId, kind: best.kind, endId: best.endId };
    }

    /** Curve id and end role owning a point id, for snap-resolved extend picks. */
    private ownerEndOf(pointId: string): { curveId: string; kind: 'line' | 'arc'; endId: string } | undefined {
        for (const [id, primitive] of this.primitives) {
            if (primitive.type === 'line' && (primitive.p1Id === pointId || primitive.p2Id === pointId)) {
                return { curveId: id, kind: 'line', endId: pointId };
            }
            if (primitive.type === 'arc' && (primitive.startId === pointId || primitive.endId === pointId)) {
                return { curveId: id, kind: 'arc', endId: pointId };
            }
        }
        return undefined;
    }

    private async extendEnd(
        curveId: string,
        kind: 'line' | 'arc',
        endId: string,
        auto: AutoConstraintFeedback[]
    ): Promise<EditCurveResult> {
        const endPos = this.getPointPosition(endId);
        if (endPos === undefined) {
            return { success: false, error: `Extend references unsolved geometry on '${curveId}'` };
        }
        const origin = endPos;
        let dir: Point2;
        if (kind === 'line') {
            const line = this.primitives.get(curveId);
            if (line?.type !== 'line') {
                return { success: false, error: `Extend needs a line, got '${curveId}'` };
            }
            const otherId = line.p1Id === endId ? line.p2Id : line.p1Id;
            const other = this.getPointPosition(otherId);
            if (other === undefined) {
                return { success: false, error: `Extend references unsolved geometry on '${curveId}'` };
            }
            const len = Math.hypot(endPos.x - other.x, endPos.y - other.y);
            if (len < 1e-12) {
                return { success: false, error: `Extend needs a non-degenerate line ('${curveId}')` };
            }
            dir = { x: (endPos.x - other.x) / len, y: (endPos.y - other.y) / len };
        } else {
            const arc = this.primitives.get(curveId);
            const frame = this.arcFrame(curveId);
            if (arc?.type !== 'arc' || frame === undefined) {
                return { success: false, error: `Extend needs an arc, got '${curveId}'` };
            }
            const rx = endPos.x - frame.center.x;
            const ry = endPos.y - frame.center.y;
            const len = Math.hypot(rx, ry);
            if (len < 1e-12) {
                return { success: false, error: `Extend needs a non-degenerate arc ('${curveId}')` };
            }
            const travel = { x: -ry / len, y: rx / len };
            const atStart = arc.startId === endId;
            const sign = frame.endAngle >= frame.startAngle !== atStart ? 1 : -1;
            dir = { x: travel.x * sign, y: travel.y * sign };
        }
        const hits = this.castRay(origin, dir, curveId);
        if (hits.length === 0) {
            return { success: false, error: `Extend found no intersecting curve ahead of '${endId}'` };
        }
        const hit = hits[0];
        if (kind === 'line') {
            await this.movePointTo(endId, hit.point);
            this.pruneDetachedPointOnObjects(curveId);
            const pointId = this.addTrimEndpointHygiene(endId, hit, auto);
            await this.commit(auto);
            return { success: true, targetId: curveId, pointId, newIds: [curveId] };
        }
        const arc = this.primitives.get(curveId);
        const frame = this.arcFrame(curveId);
        if (arc?.type !== 'arc' || frame === undefined) {
            return { success: false, error: `Extend needs an arc, got '${curveId}'` };
        }
        const atStart = arc.startId === endId;
        const hitAngle = angleOfPoint(hit.point, frame.center);
        const twoPi = 2 * Math.PI;
        let newAngle: number;
        if (frame.endAngle >= frame.startAngle) {
            let d = (hitAngle - (atStart ? frame.startAngle : frame.endAngle)) % twoPi;
            if (d < 0) {
                d += twoPi;
            }
            newAngle = (atStart ? frame.startAngle : frame.endAngle) + (atStart ? d - twoPi : d);
        } else {
            let d = ((atStart ? frame.startAngle : frame.endAngle) - hitAngle) % twoPi;
            if (d < 0) {
                d += twoPi;
            }
            newAngle = (atStart ? frame.startAngle : frame.endAngle) + (atStart ? d : -d);
        }
        const newRadius = Math.hypot(hit.point.x - frame.center.x, hit.point.y - frame.center.y);
        const newStart = atStart ? newAngle : frame.startAngle;
        const newEnd = atStart ? frame.endAngle : newAngle;
        const coords = this.solver.setPointCoordinates(endId, hit.point.x, hit.point.y);
        this.rebuildArcInPlace(curveId, arc.centerId, newRadius, newStart, newEnd, arc.startId, arc.endId, arc.construction);
        await this.solve();
        this.solver.removeConstraint(coords.xConstraintId);
        this.solver.removeConstraint(coords.yConstraintId);
        await this.solve();
        const pointId = this.addTrimEndpointHygiene(endId, hit, auto);
        this.pruneDetachedPointOnObjects(curveId);
        await this.commit(auto);
        return { success: true, targetId: curveId, pointId, newIds: [curveId] };
    }

    private async splitLine(lineId: string, click: Point2, _auto: AutoConstraintFeedback[]): Promise<EditCurveResult> {
        const line = this.primitives.get(lineId);
        if (line?.type !== 'line') {
            return { success: false, error: `Split needs a line, got '${lineId}'` };
        }
        const a = this.getPointPosition(line.p1Id);
        const b = this.getPointPosition(line.p2Id);
        if (a === undefined || b === undefined) {
            return { success: false, error: `Split references unsolved geometry on '${lineId}'` };
        }
        const projected = projectPointOntoSegment(click, a, b);
        const t = segmentParameter(projected, a, b);
        if (t <= 1e-9 || t >= 1 - 1e-9) {
            return { success: false, error: `Split needs a click on the interior of '${lineId}' — too close to the end` };
        }
        const splitId = this.nextId('point');
        this.addPointInternal(splitId, projected.x, projected.y, line.construction);
        const refs = [...this.constraints.values()].filter((record) => record.targetIds.includes(lineId));
        this.solver.removePrimitive(lineId);
        this.solver.addLine(lineId, line.p1Id, splitId, { construction: line.construction });
        const lineId2 = this.nextId('line');
        this.solver.addLine(lineId2, splitId, line.p2Id, { construction: line.construction });
        this.primitives.set(lineId, { ...line, p2Id: splitId });
        this.primitives.set(lineId2, { type: 'line', id: lineId2, p1Id: splitId, p2Id: line.p2Id, construction: line.construction });
        for (const record of refs) {
            this.solver.removeConstraint(record.id);
            if (record.kind === 'pointOnObject' && record.targetIds[1] === lineId) {
                const pos = this.getPointPosition(record.targetIds[0]);
                if (pos !== undefined && pointToSegmentDistance(pos, projected, b) <= 1e-6) {
                    record.targetIds = [record.targetIds[0], lineId2];
                    this.constraints.set(record.id, record);
                }
            }
            this.replayConstraintRecord(record);
        }
        await this.commit([]);
        return { success: true, targetId: lineId, pointId: splitId, newIds: [lineId, lineId2] };
    }

    private async splitArc(arcId: string, click: Point2, _auto: AutoConstraintFeedback[]): Promise<EditCurveResult> {
        const arc = this.primitives.get(arcId);
        if (arc?.type !== 'arc') {
            return { success: false, error: `Split needs an arc, got '${arcId}'` };
        }
        const frame = this.arcFrame(arcId);
        if (frame === undefined) {
            return { success: false, error: `Split references unsolved geometry on '${arcId}'` };
        }
        const twoPi = 2 * Math.PI;
        const sweep = frame.endAngle - frame.startAngle;
        let splitAngle: number;
        if (sweep >= 0) {
            let d = (angleOfPoint(click, frame.center) - frame.startAngle) % twoPi;
            if (d < 0) {
                d += twoPi;
            }
            if (d <= 1e-9 || sweep - d <= 1e-9) {
                return { success: false, error: `Split needs a click on the interior of '${arcId}' — too close to the end` };
            }
            splitAngle = frame.startAngle + d;
        } else {
            let d = (frame.startAngle - angleOfPoint(click, frame.center)) % twoPi;
            if (d < 0) {
                d += twoPi;
            }
            if (d <= 1e-9 || -sweep - d <= 1e-9) {
                return { success: false, error: `Split needs a click on the interior of '${arcId}' — too close to the end` };
            }
            splitAngle = frame.startAngle - d;
        }
        const splitPt = arcPointAt(frame.center, frame.radius, splitAngle);
        const splitId = this.nextId('point');
        this.addPointInternal(splitId, splitPt.x, splitPt.y, arc.construction);
        const refs = [...this.constraints.values()].filter((record) => record.targetIds.includes(arcId));
        this.solver.removePrimitive(arcId);
        this.solver.addArc(arcId, arc.centerId, frame.radius, frame.startAngle, splitAngle, arc.startId, splitId, {
            construction: arc.construction
        });
        const arcId2 = this.nextId('arc');
        this.solver.addArc(arcId2, arc.centerId, frame.radius, splitAngle, frame.endAngle, splitId, arc.endId, {
            construction: arc.construction
        });
        this.primitives.set(arcId, { ...arc, endAngle: splitAngle, endId: splitId });
        this.primitives.set(arcId2, {
            type: 'arc',
            id: arcId2,
            centerId: arc.centerId,
            radius: frame.radius,
            startAngle: splitAngle,
            endAngle: frame.endAngle,
            startId: splitId,
            endId: arc.endId,
            construction: arc.construction
        });
        for (const record of refs) {
            this.solver.removeConstraint(record.id);
            if (record.kind === 'pointOnObject' && record.targetIds[1] === arcId) {
                const pos = this.getPointPosition(record.targetIds[0]);
                if (pos !== undefined && !isAngleOnArc(angleOfPoint(pos, frame.center), frame.startAngle, splitAngle)) {
                    record.targetIds = [record.targetIds[0], arcId2];
                    this.constraints.set(record.id, record);
                }
            }
            this.replayConstraintRecord(record);
        }
        await this.commit([]);
        return { success: true, targetId: arcId, pointId: splitId, newIds: [arcId, arcId2] };
    }

    private async splitCircle(circleId: string, click: Point2, _auto: AutoConstraintFeedback[]): Promise<EditCurveResult> {
        const circle = this.primitives.get(circleId);
        if (circle?.type !== 'circle') {
            return { success: false, error: `Split needs a circle, got '${circleId}'` };
        }
        const frame = this.circleFrame(circleId);
        if (frame === undefined) {
            return { success: false, error: `Split references unsolved geometry on '${circleId}'` };
        }
        const angle = angleOfPoint(click, frame.center);
        const splitPt = arcPointAt(frame.center, frame.radius, angle);
        const oppositePt = arcPointAt(frame.center, frame.radius, angle + Math.PI);
        const splitId = this.nextId('point');
        const oppositeId = this.nextId('point');
        this.addPointInternal(splitId, splitPt.x, splitPt.y, circle.construction);
        this.addPointInternal(oppositeId, oppositePt.x, oppositePt.y, circle.construction);
        // The circle is fully removed, so every constraint it owned goes with it.
        for (const [id, record] of [...this.constraints]) {
            if (record.targetIds.includes(circleId)) {
                this.removeConstraintInternal(id);
            }
        }
        this.solver.removePrimitive(circleId);
        this.primitives.delete(circleId);
        const arcId1 = this.nextId('arc');
        const arcId2 = this.nextId('arc');
        this.addArcInternal(arcId1, circle.centerId, frame.radius, angle, angle + Math.PI, splitId, oppositeId, circle.construction);
        this.addArcInternal(
            arcId2,
            circle.centerId,
            frame.radius,
            angle + Math.PI,
            angle + 2 * Math.PI,
            oppositeId,
            splitId,
            circle.construction
        );
        await this.commit([]);
        return { success: true, targetId: circleId, pointId: splitId, newIds: [arcId1, arcId2] };
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
            if (
                this.tool === 'point' ||
                this.tool === 'line' ||
                this.tool === 'arc3' ||
                this.tool === 'rectangle' ||
                this.tool === 'slot' ||
                this.tool === 'ellipse' ||
                this.tool === 'bspline' ||
                this.tool === 'polyline' ||
                this.tool === 'polygon' ||
                this.tool === 'arcSlot' ||
                this.tool === 'move' ||
                this.tool === 'copy' ||
                this.tool === 'rotate' ||
                this.tool === 'mirrorTool'
            ) {
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

        if (this.inProgress.tool === 'slot') {
            // Centerline preview; the width/arc preview resolves on the third click.
            return { type: 'line', p1: this.inProgress.c1, p2: snapped.point };
        }

        if (this.inProgress.tool === 'ellipse') {
            const { center, major } = this.inProgress;
            if (this.inProgress.stage === 1) {
                return { type: 'line', p1: center, p2: snapped.point };
            }
            if (major === undefined) {
                return { type: 'point', point: snapped.point };
            }
            const majorRadius = Math.hypot(major.x - center.x, major.y - center.y);
            const axisLength = majorRadius;
            const nx = -(major.y - center.y) / axisLength;
            const ny = (major.x - center.x) / axisLength;
            const minorRaw = Math.abs((snapped.point.x - center.x) * nx + (snapped.point.y - center.y) * ny) || 1e-9;
            if (Math.abs(minorRaw - majorRadius) / majorRadius < 1e-6) {
                return { type: 'point', point: snapped.point };
            }
            const minor = Math.min(Math.max(minorRaw, 1e-9), majorRadius * (1 - 1e-9));
            const focal = Math.sqrt(majorRadius * majorRadius - minor * minor);
            return {
                type: 'ellipse',
                center,
                focus1: {
                    x: center.x + ((major.x - center.x) / axisLength) * focal,
                    y: center.y + ((major.y - center.y) / axisLength) * focal
                },
                radmin: minor
            };
        }

        if (this.inProgress.tool === 'bspline') {
            return { type: 'bspline', poles: [...this.inProgress.poles, snapped.point] };
        }

        if (this.inProgress.tool === 'sketchFillet' || this.inProgress.tool === 'sketchChamfer') {
            return { type: 'none' };
        }

        if (this.inProgress.tool === 'polyline') {
            if (this.inProgress.arcMid !== undefined && this.polylineMode === 'arc') {
                try {
                    const center = circleCenterFromThreePoints(this.inProgress.last, this.inProgress.arcMid, snapped.point);
                    const radius = Math.hypot(this.inProgress.last.x - center.x, this.inProgress.last.y - center.y);
                    const angles = arcAnglesFromThreePoints(center, this.inProgress.last, this.inProgress.arcMid, snapped.point);
                    return { type: 'arc', center, radius, startAngle: angles.startAngle, endAngle: angles.endAngle };
                } catch {
                    return { type: 'point', point: snapped.point };
                }
            }
            return { type: 'line', p1: this.inProgress.last, p2: snapped.point };
        }

        if (this.inProgress.tool === 'polygon') {
            return { type: 'line', p1: this.inProgress.center, p2: snapped.point };
        }

        if (this.inProgress.tool === 'arcSlot') {
            const from = this.inProgress.end ?? this.inProgress.start ?? this.inProgress.center;
            return { type: 'line', p1: from, p2: snapped.point };
        }

        if (this.inProgress.tool === 'move' || this.inProgress.tool === 'copy') {
            return { type: 'line', p1: this.inProgress.base, p2: snapped.point };
        }

        if (this.inProgress.tool === 'rotate') {
            return { type: 'line', p1: this.inProgress.center, p2: snapped.point };
        }

        return { type: 'none' };
    }

    private applySnap(raw: Point2, disableSnap?: boolean): SnapResult {
        const enabled = this.snapEnabled && !disableSnap;
        const scale = this.snapRadiusPx / SketchSession.DEFAULT_SNAP_RADIUS_PX;
        const config: SnapConfig = { ...this.snapConfig, enabled, radius: this.snapConfig.radius * scale };
        return snap(raw, this.getPrimitives(), config);
    }

    private async commit(auto: AutoConstraintFeedback[]): Promise<void> {
        await this.solve();
        this.status = { ...this.status, lastAutoConstraints: auto };
    }

    private async solve(): Promise<void> {
        const result = await this.solver.solve();
        this.applyResult(result, true);
    }

    /**
     * Fold a solver result into the session status.
     *
     * Solver-tag diagnostics always apply; validator findings are included
     * for committed solves and skipped for transient drag solves.
     */
    private applyResult(result: SolverResult, runValidators: boolean): void {
        const diagnostics = buildSolverDiagnostics(result, this.constraintKinds());
        const fullyConstrained = result.dof === 0 && result.conflicting.length === 0;
        if (runValidators && this.primitives.size > 0) {
            diagnostics.push(...this.runValidators(result.dof, fullyConstrained));
        }
        this.status = {
            dof: result.dof,
            conflicting: result.conflicting,
            redundant: result.redundant,
            partiallyRedundant: result.partiallyRedundant ?? [],
            diagnostics,
            fullyConstrained,
            lastAutoConstraints: this.status.lastAutoConstraints,
            hint: this.status.hint
        };
        this.refreshDimensionValues();
    }

    private constraintKinds(): Map<string, string> {
        const kinds = new Map<string, string>();
        for (const record of this.constraints.values()) {
            kinds.set(record.id, record.kind);
        }
        return kinds;
    }

    private refreshDimensionValues(): void {
        for (const dimension of this.dimensions.values()) {
            if (dimension.parameter !== undefined) {
                const paramValue = this.parameters.get(dimension.parameter);
                if (paramValue !== undefined) {
                    dimension.value = paramValue;
                }
                continue;
            }
            if (!dimension.driving) {
                const measured = this.measureDimension(dimension);
                if (measured !== undefined) {
                    dimension.value = measured;
                }
            }
        }
    }

    private measureDimension(dimension: SketchDimension): number | undefined {
        if (dimension.kind === 'distance' || dimension.kind === 'distanceH' || dimension.kind === 'distanceV') {
            const a = this.getPointPosition(dimension.targetIds[0]);
            const b = this.getPointPosition(dimension.targetIds[1]);
            if (a === undefined || b === undefined) {
                return undefined;
            }
            if (dimension.kind === 'distanceH') {
                return b.x - a.x;
            }
            if (dimension.kind === 'distanceV') {
                return b.y - a.y;
            }
            return Math.hypot(b.x - a.x, b.y - a.y);
        }
        if (dimension.kind === 'radius' || dimension.kind === 'diameter') {
            const primitive = this.primitives.get(dimension.targetIds[0]);
            if (primitive?.type === 'circle' || primitive?.type === 'arc') {
                const solved = this.solver.getPrimitive(primitive.id);
                const radius = solved?.type === 'circle' || solved?.type === 'arc' ? solved.radius : primitive.radius;
                return dimension.kind === 'diameter' ? radius * 2 : radius;
            }
        }
        if (dimension.kind === 'angle') {
            const l1 = this.primitives.get(dimension.targetIds[0]);
            const l2 = this.primitives.get(dimension.targetIds[1]);
            if (l1?.type !== 'line' || l2?.type !== 'line') {
                return undefined;
            }
            const a1 = this.getPointPosition(l1.p1Id);
            const a2 = this.getPointPosition(l1.p2Id);
            const b1 = this.getPointPosition(l2.p1Id);
            const b2 = this.getPointPosition(l2.p2Id);
            if (a1 === undefined || a2 === undefined || b1 === undefined || b2 === undefined) {
                return undefined;
            }
            const va = { x: a2.x - a1.x, y: a2.y - a1.y };
            const vb = { x: b2.x - b1.x, y: b2.y - b1.y };
            const dot = va.x * vb.x + va.y * vb.y;
            const det = va.x * vb.y - va.y * vb.x;
            return Math.atan2(det, dot);
        }
        return undefined;
    }

    private solveAndNotify(): Promise<void> {
        return this.solve()
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

    private addEllipseInternal(id: string, centerId: string, focus1Id: string, radmin: number, construction: boolean): void {
        finite(radmin, `Ellipse '${id}' radmin`);
        if (radmin <= 0) {
            throw new Error(`Ellipse '${id}' radmin must be positive, got ${radmin}`);
        }
        this.solver.addEllipse(id, centerId, focus1Id, radmin, { construction });
        this.primitives.set(id, { type: 'ellipse', id, centerId, focus1Id, radmin, construction });
    }

    private addBSplineInternal(
        id: string,
        poleIds: string[],
        weights: number[],
        knots: number[],
        mult: number[],
        degree: number,
        construction: boolean
    ): void {
        if (poleIds.length < 2) {
            throw new Error(`BSpline '${id}' needs at least 2 poles, got ${poleIds.length}`);
        }
        this.solver.addBSpline(id, poleIds, weights, knots, mult, degree, false, { construction });
        this.primitives.set(id, {
            type: 'bspline',
            id,
            poleIds: [...poleIds],
            weights: [...weights],
            knots: [...knots],
            mult: [...mult],
            degree,
            periodic: false,
            construction
        });
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
        // The relation popover passes ids in selection order; point-on-object
        // needs the point first, so normalize before validating.
        if (kind === 'pointOnObject' && targetIds.length === 2) {
            const firstType = this.primitives.get(targetIds[0])?.type;
            const secondType = this.primitives.get(targetIds[1])?.type;
            if (firstType !== 'point' && secondType === 'point') {
                targetIds = [targetIds[1], targetIds[0]];
            }
        }
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
                case 'radius': {
                    if (options?.diameter) {
                        this.solver.addConstraintDiameter(id, targetIds[0], value as number | string, { driving });
                    } else {
                        this.solver.addConstraintRadius(id, targetIds[0], value as number | string, { driving });
                    }
                    break;
                }
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
        if (kind === 'radius' && options?.diameter) {
            record.diameter = true;
        }
        this.constraints.set(id, record);
        if (kind === 'fix') {
            this.fixConstraintIds.set(targetIds[0], id);
        }

        let dimensionId: string | undefined;
        if (kind === 'distance' || kind === 'radius' || kind === 'angle') {
            const dimensionKind = this.inferDimensionKind(kind, options);
            dimensionId = this.createDimensionForConstraint(id, dimensionKind, targetIds, driving, value);
        }

        await this.commit([]);
        this.emitChange();
        return { success: true, constraintId: id, dimensionId };
    }

    private inferDimensionKind(kind: ConstraintKind, options?: AddConstraintOptions): DimensionKind {
        if (kind === 'distance') {
            const direction = options?.direction ?? 'point-point';
            if (direction === 'horizontal') {
                return 'distanceH';
            }
            if (direction === 'vertical') {
                return 'distanceV';
            }
            return 'distance';
        }
        if (kind === 'radius' && options?.diameter) {
            return 'diameter';
        }
        if (kind === 'radius') {
            return 'radius';
        }
        return 'angle';
    }

    private createDimensionForConstraint(
        constraintId: string,
        kind: DimensionKind,
        targetIds: string[],
        driving: boolean,
        value?: number | string
    ): string {
        const dimensionId = this.nextId('dimension');
        const numericValue = typeof value === 'number' ? value : this.resolveParameterValue(value);
        const parameter = typeof value === 'string' ? value : undefined;
        this.dimensions.set(dimensionId, {
            id: dimensionId,
            constraintId,
            kind,
            targetIds: [...targetIds],
            driving,
            parameter,
            value: numericValue
        });
        return dimensionId;
    }

    private resolveParameterValue(value?: number | string): number {
        if (typeof value === 'number') {
            return value;
        }
        if (typeof value === 'string') {
            return this.parameters.get(value) ?? 0;
        }
        return 0;
    }

    /**
     * Add a dimension explicitly.
     *
     * This is the preferred UI entry point for dimension tools: it creates the
     * underlying driving constraint and a first-class dimension record in one
     * step.
     */
    async addDimension(
        kind: DimensionKind,
        targetIds: string[],
        value: number | string,
        options?: { driving?: boolean; labelOffset?: [number, number] }
    ): Promise<AddDimensionResult> {
        const driving = options?.driving ?? true;
        if (typeof value === 'string' && !this.parameters.has(value)) {
            return { success: false, error: `Unknown parameter '${value}'` };
        }

        let constraintKind: ConstraintKind;
        let addOptions: AddConstraintOptions = { driving };
        if (kind === 'distance' || kind === 'distanceH' || kind === 'distanceV') {
            constraintKind = 'distance';
            addOptions.direction = kind === 'distanceH' ? 'horizontal' : kind === 'distanceV' ? 'vertical' : 'point-point';
        } else if (kind === 'angle') {
            constraintKind = 'angle';
        } else if (kind === 'radius') {
            constraintKind = 'radius';
        } else if (kind === 'diameter') {
            constraintKind = 'radius';
            addOptions.diameter = true;
        } else {
            return { success: false, error: `Unsupported dimension kind '${kind}'` };
        }

        const result = await this.addConstraint(constraintKind, targetIds, value, addOptions);
        if (!result.success || result.dimensionId === undefined) {
            return { success: false, error: result.error ?? 'Failed to create dimension constraint' };
        }
        const dimension = this.dimensions.get(result.dimensionId);
        if (dimension !== undefined && options?.labelOffset !== undefined) {
            dimension.labelOffset = options.labelOffset;
        }
        return { success: true, dimensionId: result.dimensionId, constraintId: result.constraintId };
    }

    /** Edit a dimension's value, parameter binding, or driving/reference state. */
    async editDimension(id: string, options: EditDimensionOptions): Promise<EditDimensionResult> {
        const dimension = this.dimensions.get(id);
        if (dimension === undefined) {
            return { success: false, error: `Unknown dimension '${id}'` };
        }
        const record = this.constraints.get(dimension.constraintId);
        if (record === undefined) {
            return { success: false, error: `Dimension '${id}' references missing constraint '${dimension.constraintId}'` };
        }

        // Parameter binding takes precedence over a literal value.
        if (options.parameter !== undefined) {
            if (options.parameter.length > 0 && !this.parameters.has(options.parameter)) {
                return { success: false, error: `Unknown parameter '${options.parameter}'` };
            }
            dimension.parameter = options.parameter.length > 0 ? options.parameter : undefined;
        }
        if (options.value !== undefined && options.parameter === undefined) {
            if (!Number.isFinite(options.value)) {
                return { success: false, error: `Dimension value must be finite, got ${options.value}` };
            }
            dimension.value = options.value;
        }
        if (options.driving !== undefined) {
            dimension.driving = options.driving;
        }

        // Recompute the effective constraint value.
        const effectiveValue = dimension.parameter ?? dimension.value;

        // Driving/reference conversion requires removing and re-adding the constraint
        // because planegcs bakes the driving flag into the constraint at creation.
        if (options.driving !== undefined) {
            const oldDimensionId = dimension.id;
            this.dimensions.delete(oldDimensionId);
            this.removeConstraintInternal(dimension.constraintId);
            const addResult = await this.addConstraint(record.kind, record.targetIds, effectiveValue, {
                driving: dimension.driving,
                direction: record.direction,
                diameter: dimension.kind === 'diameter'
            });
            if (!addResult.success || addResult.constraintId === undefined || addResult.dimensionId === undefined) {
                return { success: false, error: addResult.error ?? 'Failed to re-create constraint' };
            }
            // Replace the auto-created dimension with the original metadata.
            this.dimensions.delete(addResult.dimensionId);
            this.dimensions.set(oldDimensionId, {
                ...dimension,
                id: oldDimensionId,
                constraintId: addResult.constraintId
            });
            record.id = addResult.constraintId;
            record.driving = dimension.driving;
            record.value = effectiveValue;
            this.constraints.set(addResult.constraintId, record);
        } else {
            record.value = effectiveValue;
            this.constraints.set(dimension.constraintId, record);
            this.solver.setDrivingValue(dimension.constraintId, effectiveValue);
        }

        await this.commit([]);
        this.emitChange();
        return { success: true };
    }

    /** Delete a dimension and its underlying driving constraint. */
    async deleteDimension(id: string): Promise<EditDimensionResult> {
        const dimension = this.dimensions.get(id);
        if (dimension === undefined) {
            return { success: false, error: `Unknown dimension '${id}'` };
        }
        this.removeConstraintInternal(dimension.constraintId);
        this.dimensions.delete(id);
        await this.commit([]);
        this.emitChange();
        return { success: true };
    }

    private validateConstraint(kind: ConstraintKind, targetIds: string[], value?: number | string): string | undefined {
        const arity = (expected: number): string | undefined =>
            targetIds.length === expected ? undefined : `${kind} requires exactly ${expected} primitive(s), got ${targetIds.length}`;

        const typeOf = (id: string): 'point' | 'line' | 'circle' | 'arc' | 'ellipse' | 'bspline' | undefined =>
            this.primitives.get(id)?.type;
        const requireType = (
            ids: string[],
            types: Array<'point' | 'line' | 'circle' | 'arc' | 'ellipse' | 'bspline'>
        ): string | undefined => {
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
            case 'symmetry': {
                const err = arity(3);
                if (err !== undefined) {
                    return err;
                }
                const t1 = typeOf(targetIds[0]);
                const t2 = typeOf(targetIds[1]);
                const t3 = typeOf(targetIds[2]);
                if (t1 !== 'point' || t2 !== 'point') {
                    return `symmetry requires the first two targets to be points, got ${t1}/${t2}`;
                }
                if (t3 !== 'point' && t3 !== 'line') {
                    return `symmetry mirror must be a point or line, got ${t3}`;
                }
                return undefined;
            }
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
                } else if (other.type === 'ellipse' && (other.centerId === id || other.focus1Id === id)) {
                    result.add(otherId);
                } else if (other.type === 'bspline' && other.poleIds.includes(id)) {
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
        for (const [dimensionId, dimension] of this.dimensions.entries()) {
            if (dimension.constraintId === id) {
                this.dimensions.delete(dimensionId);
            }
        }
    }

    /** Default tolerance in model units for missing-coincident detection. */
    static readonly MISSING_COINCIDENT_TOLERANCE = 1e-6;

    /**
     * Detect point pairs that nearly coincide but share no coincident constraint.
     *
     * Pairs where both points are fixed are skipped (a coincident there would
     * be redundant). The result feeds the diagnostics channel; callers that
     * want an auto-fix can add coincident constraints for the reported pairs.
     */
    detectMissingCoincidents(tolerance: number = SketchSession.MISSING_COINCIDENT_TOLERANCE): MissingCoincident[] {
        finite(tolerance, 'Missing-coincident tolerance');
        const coincidentPairs = new Set<string>();
        for (const record of this.constraints.values()) {
            if (record.kind === 'coincident' && record.targetIds.length === 2) {
                const [a, b] = record.targetIds;
                coincidentPairs.add(a < b ? `${a}|${b}` : `${b}|${a}`);
            }
        }
        const points: Array<{ id: string; position: Point2 }> = [];
        for (const primitive of this.primitives.values()) {
            if (primitive.type !== 'point') {
                continue;
            }
            const position = this.getPointPosition(primitive.id);
            if (position !== undefined) {
                points.push({ id: primitive.id, position });
            }
        }
        const missing: MissingCoincident[] = [];
        for (let i = 0; i < points.length; i++) {
            for (let j = i + 1; j < points.length; j++) {
                const a = points[i];
                const b = points[j];
                const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
                if (coincidentPairs.has(key)) {
                    continue;
                }
                if (this.fixConstraintIds.has(a.id) && this.fixConstraintIds.has(b.id)) {
                    continue;
                }
                const distance = Math.hypot(b.position.x - a.position.x, b.position.y - a.position.y);
                if (distance <= tolerance) {
                    missing.push({ p1Id: a.id, p2Id: b.id, distance });
                }
            }
        }
        missing.sort((x, y) => x.distance - y.distance);
        return missing;
    }

    /**
     * Find open wire ends: non-construction line/arc endpoints and B-spline
     * end poles used by exactly one segment.
     *
     * Points joined by coincident constraints are merged before counting, so
     * properly closed corners are not reported. Circles and ellipses are
     * closed by definition and never contribute.
     */
    findOpenVertices(): OpenVertex[] {
        const parent = new Map<string, string>();
        const find = (id: string): string => {
            const p = parent.get(id) ?? id;
            if (p === id) {
                return id;
            }
            const root = find(p);
            parent.set(id, root);
            return root;
        };
        const union = (a: string, b: string): void => {
            const ra = find(a);
            const rb = find(b);
            if (ra !== rb) {
                parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
            }
        };
        for (const primitive of this.primitives.values()) {
            if (primitive.type === 'point') {
                find(primitive.id);
            }
        }
        for (const record of this.constraints.values()) {
            if (record.kind === 'coincident' && record.targetIds.length === 2) {
                union(record.targetIds[0], record.targetIds[1]);
            }
        }
        const incidence = new Map<string, { members: Set<string>; segments: string[] }>();
        const touch = (pointId: string, segmentId: string): void => {
            const root = find(pointId);
            let entry = incidence.get(root);
            if (entry === undefined) {
                entry = { members: new Set(), segments: [] };
                incidence.set(root, entry);
            }
            entry.members.add(pointId);
            entry.segments.push(segmentId);
        };
        for (const primitive of this.primitives.values()) {
            if (primitive.construction) {
                continue;
            }
            if (primitive.type === 'line') {
                touch(primitive.p1Id, primitive.id);
                touch(primitive.p2Id, primitive.id);
            } else if (primitive.type === 'arc') {
                touch(primitive.startId, primitive.id);
                touch(primitive.endId, primitive.id);
            } else if (primitive.type === 'bspline' && primitive.poleIds.length > 0) {
                touch(primitive.poleIds[0], primitive.id);
                touch(primitive.poleIds[primitive.poleIds.length - 1], primitive.id);
            }
        }
        const open: OpenVertex[] = [];
        for (const entry of incidence.values()) {
            if (entry.segments.length === 1) {
                open.push({ pointId: [...entry.members].sort()[0], segmentIds: [...entry.segments] });
            }
        }
        open.sort((a, b) => (a.pointId < b.pointId ? -1 : 1));
        return open;
    }

    private runValidators(dof: number, fullyConstrained: boolean): SolverDiagnostic[] {
        const diagnostics: SolverDiagnostic[] = [];
        const missing = this.detectMissingCoincidents();
        if (missing.length > 0) {
            const shown = missing.slice(0, 5).map((m) => `${m.p1Id} ≈ ${m.p2Id}`);
            const suffix = missing.length > 5 ? ` and ${missing.length - 5} more` : '';
            diagnostics.push({
                severity: 'warning',
                code: 'missing-coincident',
                constraintIds: [],
                message:
                    `Missing coincident constraints (${missing.length}): ${shown.join(', ')}${suffix}. ` +
                    'Add coincident constraints to close the sketch.'
            });
        }
        const open = this.findOpenVertices();
        if (open.length > 0) {
            const shown = open.slice(0, 5).map((v) => v.pointId);
            const suffix = open.length > 5 ? ` and ${open.length - 5} more` : '';
            diagnostics.push({
                severity: 'warning',
                code: 'open-profile',
                constraintIds: [],
                message: `Open profile: ${open.length} open vert${open.length === 1 ? 'ex' : 'ices'} (${shown.join(', ')}${suffix}).`
            });
        }
        if (fullyConstrained) {
            diagnostics.push({
                severity: 'info',
                code: 'fully-constrained',
                constraintIds: [],
                message: 'Sketch is fully constrained (0 DOF).'
            });
        } else {
            diagnostics.push({
                severity: 'info',
                code: 'under-constrained',
                constraintIds: [],
                message: `Sketch has ${dof} degree${dof === 1 ? '' : 's'} of freedom remaining.`
            });
        }
        return diagnostics;
    }

    /**
     * Freeze primitives in place (FreeCAD "Block" semantics).
     *
     * PlaneGCS has no native block constraint, so a block is emulated with
     * one fix constraint per owned point (line endpoints, circle/arc centers
     * and arc endpoints, ellipse center/focus, B-spline poles) — point-level
     * only, honoring the curve-level scope rule. Already-fixed points are
     * skipped. The created records are ordinary `fix` constraints, so they
     * serialize, restore, and render through the existing channels.
     */
    async blockPrimitives(primitiveIds: string[]): Promise<BlockResult> {
        const owned = new Set<string>();
        for (const id of primitiveIds) {
            const primitive = this.primitives.get(id);
            if (primitive === undefined) {
                return { success: false, error: `Unknown primitive '${id}'` };
            }
            for (const pointId of SketchSession.ownedPointIds(primitive)) {
                owned.add(pointId);
            }
        }
        const created: string[] = [];
        for (const pointId of [...owned].sort()) {
            if (this.fixConstraintIds.has(pointId)) {
                continue;
            }
            const fixId = this.nextId('fix');
            try {
                this.solver.addConstraintFix(fixId, pointId);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return { success: false, error: message };
            }
            this.constraints.set(fixId, { id: fixId, kind: 'fix', targetIds: [pointId], driving: true });
            this.fixConstraintIds.set(pointId, fixId);
            created.push(fixId);
        }
        await this.commit([]);
        this.emitChange();
        return { success: true, constraintIds: created };
    }

    private static ownedPointIds(primitive: SketchPrimitive): string[] {
        switch (primitive.type) {
            case 'point':
                return [primitive.id];
            case 'line':
                return [primitive.p1Id, primitive.p2Id];
            case 'circle':
                return [primitive.centerId];
            case 'arc':
                return [primitive.centerId, primitive.startId, primitive.endId];
            case 'ellipse':
                return [primitive.centerId, primitive.focus1Id];
            case 'bspline':
                return [...primitive.poleIds];
        }
    }

    /**
     * Insert a tangent arc fillet between two lines sharing a corner point.
     *
     * The shared corner is replaced by two tangent points (both lines are
     * rebuilt in the solver with the same ids, so line-level constraints such
     * as horizontal/parallel/angle are preserved via replay) and the corner
     * point is removed. The fillet radius goes through the normal dimension
     * path, so it stays editable and parameter-bindable.
     *
     * The corner point must carry no other constraints or dimensions;
     * otherwise the fillet is rejected with a descriptive error.
     */
    async filletCorner(lineId1: string, lineId2: string, radius: number | string): Promise<FilletResult> {
        const l1 = this.primitives.get(lineId1);
        const l2 = this.primitives.get(lineId2);
        if (l1?.type !== 'line' || l2?.type !== 'line') {
            return { success: false, error: 'fillet requires two lines' };
        }
        if (lineId1 === lineId2) {
            return { success: false, error: 'fillet requires two distinct lines' };
        }
        const corner = [l1.p1Id, l1.p2Id].find((e) => e === l2.p1Id || e === l2.p2Id);
        if (corner === undefined) {
            return { success: false, error: 'fillet requires two lines sharing a corner point' };
        }
        let radiusValue: number;
        if (typeof radius === 'string') {
            const bound = this.parameters.get(radius);
            if (bound === undefined) {
                return { success: false, error: `Unknown parameter '${radius}'` };
            }
            radiusValue = bound;
        } else {
            radiusValue = radius;
        }
        if (!Number.isFinite(radiusValue) || radiusValue <= 0) {
            return { success: false, error: `Fillet radius must be positive, got ${radius}` };
        }
        const other1 = l1.p1Id === corner ? l1.p2Id : l1.p1Id;
        const other2 = l2.p1Id === corner ? l2.p2Id : l2.p1Id;
        const cornerPos = this.getPointPosition(corner);
        const pos1 = this.getPointPosition(other1);
        const pos2 = this.getPointPosition(other2);
        if (cornerPos === undefined || pos1 === undefined || pos2 === undefined) {
            return { success: false, error: 'fillet corner references unsolved geometry' };
        }
        const len1 = Math.hypot(pos1.x - cornerPos.x, pos1.y - cornerPos.y);
        const len2 = Math.hypot(pos2.x - cornerPos.x, pos2.y - cornerPos.y);
        if (len1 < 1e-12 || len2 < 1e-12) {
            return { success: false, error: 'fillet requires non-degenerate lines' };
        }
        const u = { x: (pos1.x - cornerPos.x) / len1, y: (pos1.y - cornerPos.y) / len1 };
        const v = { x: (pos2.x - cornerPos.x) / len2, y: (pos2.y - cornerPos.y) / len2 };
        const cosTheta = Math.min(1, Math.max(-1, u.x * v.x + u.y * v.y));
        const theta = Math.acos(cosTheta);
        if (theta < 1e-6 || Math.PI - theta < 1e-6) {
            return { success: false, error: 'fillet requires non-collinear lines' };
        }
        const tangentDistance = radiusValue / Math.tan(theta / 2);
        if (tangentDistance >= len1 || tangentDistance >= len2) {
            return {
                success: false,
                error: `Fillet radius ${radiusValue} is too large for the corner (max ${Math.min(len1, len2).toFixed(6)})`
            };
        }
        const blockers = [...this.constraints.values()].filter((record) => record.targetIds.includes(corner));
        if (blockers.length > 0) {
            return {
                success: false,
                error: `Corner point '${corner}' is constrained (${blockers.map((r) => r.id).join(', ')}); remove those constraints first`
            };
        }
        const dimensionBlockers = [...this.dimensions.values()].filter((dimension) => dimension.targetIds.includes(corner));
        if (dimensionBlockers.length > 0) {
            return {
                success: false,
                error: `Corner point '${corner}' drives dimension(s) (${dimensionBlockers.map((d) => d.id).join(', ')}); remove them first`
            };
        }

        const t1 = { x: cornerPos.x + u.x * tangentDistance, y: cornerPos.y + u.y * tangentDistance };
        const t2 = { x: cornerPos.x + v.x * tangentDistance, y: cornerPos.y + v.y * tangentDistance };
        const bisector = { x: u.x + v.x, y: u.y + v.y };
        const bisectorLength = Math.hypot(bisector.x, bisector.y);
        const center = {
            x: cornerPos.x + (bisector.x / bisectorLength) * (radiusValue / Math.sin(theta / 2)),
            y: cornerPos.y + (bisector.y / bisectorLength) * (radiusValue / Math.sin(theta / 2))
        };
        const t1Id = this.nextId('point');
        const t2Id = this.nextId('point');
        const centerId = this.nextId('point');
        this.addPointInternal(t1Id, t1.x, t1.y, false);
        this.addPointInternal(t2Id, t2.x, t2.y, false);
        this.addPointInternal(centerId, center.x, center.y, false);

        try {
            const refs = [...this.constraints.values()].filter(
                (record) => record.targetIds.includes(lineId1) || record.targetIds.includes(lineId2)
            );
            this.solver.removePrimitive(lineId1);
            this.solver.removePrimitive(lineId2);
            const newEnds1: [string, string] = [l1.p1Id === corner ? t1Id : l1.p1Id, l1.p2Id === corner ? t1Id : l1.p2Id];
            const newEnds2: [string, string] = [l2.p1Id === corner ? t2Id : l2.p1Id, l2.p2Id === corner ? t2Id : l2.p2Id];
            this.solver.addLine(lineId1, newEnds1[0], newEnds1[1], { construction: l1.construction });
            this.solver.addLine(lineId2, newEnds2[0], newEnds2[1], { construction: l2.construction });
            this.primitives.set(lineId1, { ...l1, p1Id: newEnds1[0], p2Id: newEnds1[1] });
            this.primitives.set(lineId2, { ...l2, p1Id: newEnds2[0], p2Id: newEnds2[1] });
            for (const record of refs) {
                this.replayConstraintRecord(record);
            }
            this.solver.removePrimitive(corner);
            this.primitives.delete(corner);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await this.commit([]);
            this.emitChange();
            return { success: false, error: message };
        }

        // The sweep through the old corner side picks the outward fillet arc.
        const angles = arcAnglesFromThreePoints(center, t1, cornerPos, t2);
        const arcId = this.nextId('arc');
        this.addArcInternal(arcId, centerId, radiusValue, angles.startAngle, angles.endAngle, t1Id, t2Id, false);
        const tangentIds: string[] = [];
        for (const lineId of [lineId1, lineId2]) {
            const tangentId = this.nextId('tangent');
            this.solver.addConstraintTangent(tangentId, lineId, arcId, { driving: true });
            this.constraints.set(tangentId, { id: tangentId, kind: 'tangent', targetIds: [lineId, arcId], driving: true });
            tangentIds.push(tangentId);
        }
        const radiusResult = await this.addConstraint('radius', [arcId], radius);
        if (!radiusResult.success) {
            return { success: false, error: radiusResult.error };
        }
        return { success: true, arcId, dimensionId: radiusResult.dimensionId, constraintId: radiusResult.constraintId };
    }

    /**
     * Re-apply a session constraint record to the solver under its same id.
     *
     * Used after solver-side primitive surgery (sketch fillet) that drops the
     * solver's constraint copies while the session records survive.
     */
    private replayConstraintRecord(record: ConstraintRecord): void {
        const driving = record.driving;
        const ids = record.targetIds;
        switch (record.kind) {
            case 'coincident':
                this.solver.addConstraintCoincident(record.id, ids[0], ids[1], { driving });
                break;
            case 'fix':
                this.solver.addConstraintFix(record.id, ids[0]);
                break;
            case 'horizontal':
                this.solver.addConstraintHorizontal(record.id, ids[0], { driving });
                break;
            case 'vertical':
                this.solver.addConstraintVertical(record.id, ids[0], { driving });
                break;
            case 'parallel':
                this.solver.addConstraintParallel(record.id, ids[0], ids[1], { driving });
                break;
            case 'perpendicular':
                this.solver.addConstraintPerpendicular(record.id, ids[0], ids[1], { driving });
                break;
            case 'tangent':
                this.solver.addConstraintTangent(record.id, ids[0], ids[1], { driving });
                break;
            case 'equal':
                this.solver.addConstraintEqual(record.id, ids[0], ids[1], { driving });
                break;
            case 'angle':
                this.solver.addConstraintAngle(record.id, ids[0], ids[1], record.value as number | string, { driving });
                break;
            case 'pointOnObject':
                this.solver.addConstraintPointOnObject(record.id, ids[0], ids[1], { driving });
                break;
            case 'symmetry':
                this.solver.addConstraintSymmetry(record.id, ids[0], ids[1], ids[2], { driving });
                break;
            case 'concentric':
                this.solver.addConstraintConcentric(record.id, ids[0], ids[1], { driving });
                break;
            case 'distance':
                this.solver.addConstraintDistance(record.id, ids[0], ids[1], record.value as number | string, {
                    driving,
                    direction: record.direction ?? 'point-point'
                });
                break;
            case 'radius':
                if (record.diameter) {
                    this.solver.addConstraintDiameter(record.id, ids[0], record.value as number | string, { driving });
                } else {
                    this.solver.addConstraintRadius(record.id, ids[0], record.value as number | string, { driving });
                }
                break;
        }
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

    /**
     * Import another sketch's content into this session (FreeCAD "carbon copy").
     *
     * Every primitive, constraint, and dimension id is remapped into a
     * `cc<N>-` namespace unique to this copy operation, so repeated copies
     * never collide with each other or with existing session ids. Constraint
     * endpoint ids and dimension `constraintId`/`targetIds` follow the remap;
     * construction flags, fixed points, driving flags, parameter bindings
     * (missing sketch-local parameters are added), and dimension label
     * offsets are preserved. Source `externalRefs` are copied as-is: they
     * reference document features, which stay valid in the target session.
     *
     * Copying a sketch onto itself is rejected with a clear error. The copy
     * is validated before anything is mutated, so a failure leaves the
     * session unchanged; the result round-trips through {@link toSketchDef}
     * and re-validates via {@link validateDocument}.
     */
    async carbonCopyFrom(source: SketchDef): Promise<CarbonCopyResult> {
        if (source.id === this.id) {
            return { addedPrimitiveIds: [], error: `Cannot carbon-copy sketch '${source.id}' onto itself` };
        }
        this.carbonCopyCount += 1;
        const namespace = `cc${this.carbonCopyCount}`;
        const claimed = new Set<string>();
        const claimId = (base: string): string => {
            let candidate = base;
            let suffix = 0;
            while (this.primitives.has(candidate) || this.constraints.has(candidate) || claimed.has(candidate)) {
                suffix += 1;
                candidate = `${base}-x${suffix}`;
            }
            claimed.add(candidate);
            return candidate;
        };

        // Phase 1 (no mutation): remap every id and validate references, so a
        // malformed source fails before the session is touched.
        const primitiveMap = new Map<string, string>();
        const seenSourceIds = new Set<string>();
        for (const raw of source.primitives) {
            const oldId = String(raw.id);
            if (seenSourceIds.has(oldId)) {
                return { addedPrimitiveIds: [], error: `Cannot carbon-copy sketch '${source.id}': duplicate primitive id '${oldId}'` };
            }
            seenSourceIds.add(oldId);
            primitiveMap.set(oldId, claimId(`${namespace}-${oldId}`));
        }
        const remapPrimitive = (id: unknown): string => {
            const mapped = primitiveMap.get(String(id));
            if (mapped === undefined) {
                throw new Error(`Cannot carbon-copy sketch '${source.id}': unknown primitive reference '${String(id)}'`);
            }
            return mapped;
        };

        const stagedApplies: Array<() => void | Promise<void>> = [];
        const addedPrimitiveIds: string[] = [];
        const fixedPointIds: string[] = [];
        try {
            for (const [name, value] of Object.entries(source.parameters ?? {})) {
                if (!Number.isFinite(value)) {
                    throw new Error(`Cannot carbon-copy sketch '${source.id}': parameter '${name}' is not finite`);
                }
                if (!this.parameters.has(name)) {
                    stagedApplies.push(() => this.addParameterInternal(name, value));
                }
            }

            // Points first because higher geometry references them.
            for (const raw of source.primitives) {
                if (typeof raw.type !== 'string' || raw.type !== 'point') {
                    continue;
                }
                const x = Number(raw.x);
                const y = Number(raw.y);
                finite(x, `Point '${String(raw.id)}' x`);
                finite(y, `Point '${String(raw.id)}' y`);
                const newId = primitiveMap.get(String(raw.id))!;
                const construction = Boolean(raw.construction);
                const fixed = Boolean(raw.fixed);
                stagedApplies.push(() => {
                    this.addPointInternal(newId, x, y, construction);
                    addedPrimitiveIds.push(newId);
                    if (fixed) {
                        fixedPointIds.push(newId);
                    }
                });
            }

            for (const raw of source.primitives) {
                if (typeof raw.type !== 'string' || raw.type === 'point') {
                    continue;
                }
                const newId = primitiveMap.get(String(raw.id));
                if (newId === undefined) {
                    continue;
                }
                const construction = Boolean(raw.construction);
                if (raw.type === 'line') {
                    const p1Id = remapPrimitive(raw.p1_id ?? raw.p1Id);
                    const p2Id = remapPrimitive(raw.p2_id ?? raw.p2Id);
                    stagedApplies.push(() => {
                        this.addLineInternal(newId, p1Id, p2Id, construction);
                        addedPrimitiveIds.push(newId);
                    });
                } else if (raw.type === 'circle') {
                    const centerId = remapPrimitive(raw.c_id ?? raw.centerId);
                    const radius = Number(raw.radius);
                    finite(radius, `Circle '${String(raw.id)}' radius`);
                    stagedApplies.push(() => {
                        this.addCircleInternal(newId, centerId, radius, construction);
                        addedPrimitiveIds.push(newId);
                    });
                } else if (raw.type === 'arc') {
                    const centerId = remapPrimitive(raw.c_id ?? raw.centerId);
                    const radius = Number(raw.radius);
                    const startAngle = Number(raw.start_angle ?? raw.startAngle);
                    const endAngle = Number(raw.end_angle ?? raw.endAngle);
                    const startId = remapPrimitive(raw.start_id ?? raw.startId);
                    const endId = remapPrimitive(raw.end_id ?? raw.endId);
                    finite(radius, `Arc '${String(raw.id)}' radius`);
                    finite(startAngle, `Arc '${String(raw.id)}' startAngle`);
                    finite(endAngle, `Arc '${String(raw.id)}' endAngle`);
                    stagedApplies.push(() => {
                        this.addArcInternal(newId, centerId, radius, startAngle, endAngle, startId, endId, construction);
                        addedPrimitiveIds.push(newId);
                    });
                } else if (raw.type === 'ellipse') {
                    const centerId = remapPrimitive(raw.c_id ?? raw.centerId);
                    const focus1Id = remapPrimitive(raw.focus1_id ?? raw.focus1Id);
                    const radmin = Number(raw.radmin);
                    finite(radmin, `Ellipse '${String(raw.id)}' radmin`);
                    stagedApplies.push(() => {
                        this.addEllipseInternal(newId, centerId, focus1Id, radmin, construction);
                        addedPrimitiveIds.push(newId);
                    });
                } else if (raw.type === 'bspline') {
                    const poleIds = ((raw.pole_ids ?? raw.poleIds ?? []) as unknown[]).map(remapPrimitive);
                    const weights = ((raw.weights ?? []) as unknown[]).map(Number);
                    const knots = ((raw.knots ?? []) as unknown[]).map(Number);
                    const mult = ((raw.mult ?? []) as unknown[]).map(Number);
                    const degree = Number(raw.degree);
                    if (poleIds.length < 2) {
                        throw new Error(`Cannot carbon-copy sketch '${source.id}': BSpline '${String(raw.id)}' needs at least 2 poles`);
                    }
                    stagedApplies.push(() => {
                        this.addBSplineInternal(newId, poleIds, weights, knots, mult, degree, construction);
                        addedPrimitiveIds.push(newId);
                    });
                }
                // Unknown primitive types are ignored, mirroring fromSketchDef.
            }

            // Remap constraint endpoint ids; the fresh constraint id is
            // recorded only when the load actually registers it (unknown
            // planegcs types are ignored by the loader, mirroring
            // fromSketchDef), so dangling dimension references can be skipped.
            const stagedConstraints: Array<{ oldId: string; newId: string; record: Record<string, unknown> }> = [];
            for (const raw of source.constraints) {
                const oldId = String(raw.id);
                const newId = claimId(`${namespace}-${oldId}`);
                const record: Record<string, unknown> = { ...raw, id: newId };
                this.remapCarbonCopyConstraintIds(record, remapPrimitive, source.id);
                stagedConstraints.push({ oldId, newId, record });
            }
            const copiedConstraintIds = new Map<string, string>();
            stagedApplies.push(async () => {
                for (const staged of stagedConstraints) {
                    await this.loadConstraintFromPg(staged.record);
                    if (this.constraints.has(staged.newId)) {
                        copiedConstraintIds.set(staged.oldId, staged.newId);
                    }
                }
            });

            stagedApplies.push(() => {
                for (const pointId of fixedPointIds) {
                    const constraintId = this.nextId('fix');
                    this.solver.addConstraintFix(constraintId, pointId);
                    this.constraints.set(constraintId, { id: constraintId, kind: 'fix', targetIds: [pointId], driving: true });
                    this.fixConstraintIds.set(pointId, constraintId);
                }
            });

            // Dimensions resolve against the loaded constraints, so they are
            // staged to run after the constraint load above. Dimensions whose
            // constraint was not copied (unknown planegcs type) or whose
            // targets are missing are skipped: dimensions are UI metadata and
            // must never fail the geometry copy.
            stagedApplies.push(() => {
                for (const dimension of source.dimensions ?? []) {
                    const targetIds: string[] = [];
                    let resolved = true;
                    for (const targetId of dimension.targetIds) {
                        const mapped = primitiveMap.get(targetId);
                        if (mapped === undefined) {
                            resolved = false;
                            break;
                        }
                        targetIds.push(mapped);
                    }
                    const newConstraintId = copiedConstraintIds.get(dimension.constraintId);
                    if (!resolved || newConstraintId === undefined) {
                        continue;
                    }
                    const newId = claimId(`${namespace}-${dimension.id}`);
                    const numericValue =
                        typeof dimension.value === 'number' && Number.isFinite(dimension.value)
                            ? dimension.value
                            : this.resolveParameterValue(dimension.parameter ?? dimension.value);
                    this.dimensions.set(newId, {
                        id: newId,
                        constraintId: newConstraintId,
                        kind: dimension.kind,
                        targetIds,
                        driving: dimension.driving,
                        parameter: dimension.parameter,
                        value: numericValue,
                        labelOffset: dimension.labelOffset === undefined ? undefined : [dimension.labelOffset[0], dimension.labelOffset[1]]
                    });
                }
            });

            if (source.externalRefs !== undefined) {
                const refs = source.externalRefs.map((ref) => cloneTopologyRef(ref));
                stagedApplies.push(() => {
                    for (const ref of refs) {
                        this.externalRefs.push(ref);
                    }
                });
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { addedPrimitiveIds: [], error: message };
        }

        // Phase 2: the staged work only touches validated ids, so a solver
        // failure here is unexpected; still solve (which refreshes status)
        // and report rather than throw.
        try {
            for (const apply of stagedApplies) {
                await apply();
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await this.solveAndNotify();
            return { addedPrimitiveIds, error: message };
        }
        await this.solveAndNotify();
        return { addedPrimitiveIds };
    }

    /**
     * Remap the primitive endpoint ids inside one planegcs-verbatim
     * constraint record in place (constraint `id` is handled by the caller).
     */
    private remapCarbonCopyConstraintIds(record: Record<string, unknown>, remapPrimitive: (id: unknown) => string, sourceId: string): void {
        void sourceId;
        for (const [key, value] of Object.entries(record)) {
            if (CARBON_COPY_PRIMITIVE_ID_FIELDS.has(key) && typeof value === 'string') {
                record[key] = remapPrimitive(value);
            } else if ((key === 'param1' || key === 'param2') && typeof value === 'object' && value !== null) {
                const param = value as Record<string, unknown>;
                for (const nested of ['o_id', 'oId']) {
                    if (typeof param[nested] === 'string') {
                        param[nested] = remapPrimitive(param[nested]);
                    }
                }
            }
        }
    }

    /**
     * Expose an ellipse's internal alignment geometry as construction aids.
     *
     * Adds the second focus (mirrored through the center: `f2 = 2c - f1`) as
     * a construction point, plus major-axis and minor-axis construction lines
     * through the foci/center. The major-axis line reuses the existing focus1
     * point and the new focus2 point as its endpoints, so it tracks later
     * edits; the minor-axis line is centered on the ellipse center,
     * perpendicular to the major axis, with the minor semi-axis as its
     * half-length. Deliberately no constraints are added, so every new
     * primitive is non-driving and the sketch can never be over-constrained
     * by exposed internals.
     *
     * Note: B-spline poles need nothing here — they are already ordinary
     * session points, so there is no internal-exposure API for B-splines and
     * no knot UI.
     */
    async exposeEllipseInternals(ellipseId: string): Promise<ExposeEllipseInternalsResult> {
        const ellipse = this.primitives.get(ellipseId);
        if (ellipse === undefined) {
            return { success: false, error: `Unknown primitive '${ellipseId}'` };
        }
        if (ellipse.type !== 'ellipse') {
            return { success: false, error: `Primitive '${ellipseId}' is a ${ellipse.type}, not an ellipse` };
        }
        const center = this.getPointPosition(ellipse.centerId);
        const focus1 = this.getPointPosition(ellipse.focus1Id);
        if (center === undefined || focus1 === undefined) {
            return { success: false, error: `Ellipse '${ellipseId}' references unsolved geometry` };
        }
        const dx = focus1.x - center.x;
        const dy = focus1.y - center.y;
        const focal = Math.hypot(dx, dy);
        if (focal < 1e-12) {
            return { success: false, error: `Ellipse '${ellipseId}' is degenerate (center coincides with focus); no axis to expose` };
        }
        const solved = this.solver.getPrimitive(ellipseId);
        const radmin = solved?.type === 'ellipse' ? solved.radmin : ellipse.radmin;

        const focus2Id = this.nextId('point');
        this.addPointInternal(focus2Id, 2 * center.x - focus1.x, 2 * center.y - focus1.y, true);

        const majorAxisLineId = this.nextId('line');
        this.addLineInternal(majorAxisLineId, ellipse.focus1Id, focus2Id, true);

        const nx = -dy / focal;
        const ny = dx / focal;
        const minor1Id = this.nextId('point');
        const minor2Id = this.nextId('point');
        this.addPointInternal(minor1Id, center.x + nx * radmin, center.y + ny * radmin, true);
        this.addPointInternal(minor2Id, center.x - nx * radmin, center.y - ny * radmin, true);
        const minorAxisLineId = this.nextId('line');
        this.addLineInternal(minorAxisLineId, minor1Id, minor2Id, true);

        await this.commit([]);
        this.emitChange();
        return { success: true, focus2Id, majorAxisLineId, minorAxisLineId };
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
            partiallyRedundant: result.partiallyRedundant ?? [],
            diagnostics: buildSolverDiagnostics(result, this.constraintKinds()),
            fullyConstrained: result.dof === 0 && result.conflicting.length === 0,
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
            const addedCoords: Array<{ xId: string; yId: string; pointId: string }> = [];
            for (const pointId of pointIds) {
                if (this.fixConstraintIds.has(pointId)) {
                    continue;
                }
                const pos = lastSolvedPositions.get(pointId);
                if (pos === undefined) {
                    continue;
                }
                const ids = this.solver.setPointCoordinates(pointId, pos.x, pos.y);
                addedCoords.push({ xId: ids.xConstraintId, yId: ids.yConstraintId, pointId });
            }

            result = await this.solver.solve();
            if (result.status === 'converged') {
                // FreeCAD-style: the dropped point stays at the solved location
                // but is no longer pinned. Removing the temporary coordinate
                // drivers keeps the solved coordinates as the initial state and
                // yields an accurate DOF count.
                for (const { xId, yId } of addedCoords) {
                    this.solver.removeConstraint(xId);
                    this.solver.removeConstraint(yId);
                }
                result = await this.solver.solve();
                if (result.status !== 'converged') {
                    result = await this.restoreOldFixesAndSolve(oldFixes);
                }
            } else {
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
            partiallyRedundant: result.partiallyRedundant ?? [],
            diagnostics: buildSolverDiagnostics(result, this.constraintKinds()),
            fullyConstrained: result.dof === 0 && result.conflicting.length === 0,
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
            } else if (p.type === 'ellipse') {
                const ellipse = (solved as SketchEllipse | undefined) ?? p;
                obj.c_id = p.centerId;
                obj.focus1_id = p.focus1Id;
                obj.radmin = ellipse.radmin;
            } else if (p.type === 'bspline') {
                obj.pole_ids = [...p.poleIds];
                obj.weights = [...p.weights];
                obj.knots = [...p.knots];
                obj.mult = [...p.mult];
                obj.degree = p.degree;
                obj.periodic = p.periodic;
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
            if (!this.inheritedParameterNames.has(name)) {
                parameters[name] = value;
            }
        }

        const dimensions = [...this.dimensions.values()];
        const externalRefs = this.externalRefs.length > 0 ? this.externalRefs.map((r) => cloneTopologyRef(r)) : undefined;

        return {
            id: this.id,
            name: this.name,
            datumId: this.datumId,
            primitives,
            constraints,
            parameters,
            dimensions,
            externalRefs
        };
    }

    private constraintToPg(record: ConstraintRecord): Record<string, unknown> | Record<string, unknown>[] {
        const driving = record.driving;
        const ids = record.targetIds;
        const value = record.value;
        switch (record.kind) {
            case 'coincident':
                return { id: record.id, type: 'p2p_coincident', p1_id: ids[0], p2_id: ids[1], driving };
            case 'symmetry': {
                const mirrorType = this.primitives.get(ids[2])?.type;
                if (mirrorType === 'line') {
                    return { id: record.id, type: 'p2p_symmetric_ppl', p1_id: ids[0], p2_id: ids[1], l_id: ids[2], driving };
                }
                return { id: record.id, type: 'p2p_symmetric_ppp', p1_id: ids[0], p2_id: ids[1], p_id: ids[2], driving };
            }
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
                if (record.diameter) {
                    if (p.type === 'circle') {
                        return { id: record.id, type: 'circle_diameter', c_id: ids[0], diameter: value, driving };
                    }
                    return { id: record.id, type: 'arc_diameter', a_id: ids[0], diameter: value, driving };
                }
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
            this.constraints.set(id, { id, kind: 'radius', targetIds: [cId], value: diameter, driving, diameter: true });
        } else if (type === 'arc_diameter') {
            const aId = String(pg.a_id ?? pg.aId);
            const diameter = pg.diameter as number | string;
            this.solver.addConstraintDiameter(id, aId, diameter, { driving });
            this.constraints.set(id, { id, kind: 'radius', targetIds: [aId], value: diameter, driving, diameter: true });
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
            bodies: [],
            sketches: [this.toSketchDef()],
            features: [],
            curves: []
        };
        const result = validateNukeCadDocument(doc);
        return { valid: result.valid, issues: result.issues.map((i) => `${i.path}: ${i.message}`) };
    }
}
