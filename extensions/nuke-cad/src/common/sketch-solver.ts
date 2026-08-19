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
 * Solver-agnostic adapter over `@salusoft89/planegcs` (FreeCAD PlaneGCS WASM).
 *
 * No other module in the codebase imports planegcs directly. This file is the
 * isolation layer described in the nuke-cad GUI modeler program plan §3.5.
 *
 * @module nuke-cad/common
 */

// The @salusoft89/planegcs package is ESM-only while this extension compiles
// to CommonJS. We load it dynamically and use these local type mirrors for the
// subset of its API we consume, avoiding ESM/CJS type-import friction.

interface PgId {
    id: string;
}

interface PgSketchPoint extends PgId {
    type: 'point';
    x: number;
    y: number;
    fixed: boolean;
}

interface PgSketchLine extends PgId {
    type: 'line';
    p1_id: string;
    p2_id: string;
}

interface PgSketchCircle extends PgId {
    type: 'circle';
    c_id: string;
    radius: number;
}

interface PgSketchArc extends PgId {
    type: 'arc';
    c_id: string;
    radius: number;
    start_angle: number;
    end_angle: number;
    start_id: string;
    end_id: string;
}

type PgSketchGeometry = PgSketchPoint | PgSketchLine | PgSketchCircle | PgSketchArc;

interface PgConstraintBase extends PgId {
    driving?: boolean;
    temporary?: boolean;
    scale?: number;
}

interface P2PCoincident extends PgConstraintBase {
    type: 'p2p_coincident';
    p1_id: string;
    p2_id: string;
}

interface P2PDistance extends PgConstraintBase {
    type: 'p2p_distance';
    p1_id: string;
    p2_id: string;
    distance: number | string | PgObjectParam;
}

interface Parallel extends PgConstraintBase {
    type: 'parallel';
    l1_id: string;
    l2_id: string;
}

interface Perpendicular_LL extends PgConstraintBase {
    type: 'perpendicular_ll';
    l1_id: string;
    l2_id: string;
}

interface Horizontal_L extends PgConstraintBase {
    type: 'horizontal_l';
    l_id: string;
}

interface Vertical_L extends PgConstraintBase {
    type: 'vertical_l';
    l_id: string;
}

interface L2LAngle_LL extends PgConstraintBase {
    type: 'l2l_angle_ll';
    l1_id: string;
    l2_id: string;
    angle: number | string | PgObjectParam;
}

interface Tangent_LC extends PgConstraintBase {
    type: 'tangent_lc';
    l_id: string;
    c_id: string;
}

interface Tangent_LA extends PgConstraintBase {
    type: 'tangent_la';
    l_id: string;
    a_id: string;
}

interface Tangent_CC extends PgConstraintBase {
    type: 'tangent_cc';
    c1_id: string;
    c2_id: string;
}

interface Tangent_AA extends PgConstraintBase {
    type: 'tangent_aa';
    a1_id: string;
    a2_id: string;
}

interface Tangent_CA extends PgConstraintBase {
    type: 'tangent_ca';
    c_id: string;
    a_id: string;
}

interface Equal extends PgConstraintBase {
    type: 'equal';
    param1: number | string | PgObjectParam;
    param2: number | string | PgObjectParam;
}

interface EqualLength extends PgConstraintBase {
    type: 'equal_length';
    l1_id: string;
    l2_id: string;
}

interface EqualRadius_CC extends PgConstraintBase {
    type: 'equal_radius_cc';
    c1_id: string;
    c2_id: string;
}

interface EqualRadius_AA extends PgConstraintBase {
    type: 'equal_radius_aa';
    a1_id: string;
    a2_id: string;
}

interface EqualRadius_CA extends PgConstraintBase {
    type: 'equal_radius_ca';
    c1_id: string;
    a2_id: string;
}

interface CircleRadius extends PgConstraintBase {
    type: 'circle_radius';
    c_id: string;
    radius: number | string | PgObjectParam;
}

interface ArcRadius extends PgConstraintBase {
    type: 'arc_radius';
    a_id: string;
    radius: number | string | PgObjectParam;
}

interface CircleDiameter extends PgConstraintBase {
    type: 'circle_diameter';
    c_id: string;
    diameter: number | string | PgObjectParam;
}

interface ArcDiameter extends PgConstraintBase {
    type: 'arc_diameter';
    a_id: string;
    diameter: number | string | PgObjectParam;
}

interface P2PSymmetric_PPL extends PgConstraintBase {
    type: 'p2p_symmetric_ppl';
    p1_id: string;
    p2_id: string;
    l_id: string;
}

interface P2PSymmetric_PPP extends PgConstraintBase {
    type: 'p2p_symmetric_ppp';
    p1_id: string;
    p2_id: string;
    p_id: string;
}

interface Difference extends PgConstraintBase {
    type: 'difference';
    param1: number | string | PgObjectParam;
    param2: number | string | PgObjectParam;
    difference: number | string | PgObjectParam;
}

interface CoordinateX extends PgConstraintBase {
    type: 'coordinate_x';
    p_id: string;
    x: number | string | PgObjectParam;
}

interface CoordinateY extends PgConstraintBase {
    type: 'coordinate_y';
    p_id: string;
    y: number | string | PgObjectParam;
}

interface PgObjectParam {
    o_id: string;
    prop: 'x' | 'y' | 'radius' | 'start_angle' | 'end_angle' | 'radmin';
}

type PgConstraint =
    | P2PCoincident
    | P2PDistance
    | Parallel
    | Perpendicular_LL
    | Horizontal_L
    | Vertical_L
    | L2LAngle_LL
    | Tangent_LC
    | Tangent_LA
    | Tangent_CC
    | Tangent_AA
    | Tangent_CA
    | Equal
    | EqualLength
    | EqualRadius_CC
    | EqualRadius_AA
    | EqualRadius_CA
    | CircleRadius
    | ArcRadius
    | CircleDiameter
    | ArcDiameter
    | P2PSymmetric_PPL
    | P2PSymmetric_PPP
    | Difference
    | CoordinateX
    | CoordinateY;

type PgSketchPrimitive = PgSketchGeometry | PgConstraint;

interface PgSketchParam {
    type: 'param';
    name: string;
    value: number;
}

interface PgSketchIndex {
    get_primitives(): PgSketchPrimitive[];
}

interface PgGcsSystem {
    dof(): number;
    [key: string]: unknown;
}

interface PgGcsWrapper {
    readonly gcs: PgGcsSystem;
    readonly sketch_index: PgSketchIndex;
    clear_data(): void;
    push_primitives_and_params(objects: (PgSketchPrimitive | PgSketchParam)[]): void;
    solve(algorithm?: number): number;
    apply_solution(): void;
    get_gcs_conflicting_constraints(): string[];
    get_gcs_redundant_constraints(): string[];
    destroy_gcs_module(): void;
}

interface PgModule {
    init_planegcs_module(options?: { locateFile?: (path: string) => string }): Promise<{
        GcsSystem: new () => PgGcsSystem;
    }>;
    GcsWrapper: new (gcs: PgGcsSystem, mod?: unknown) => PgGcsWrapper;
    Algorithm: { readonly DogLeg: number; readonly BFGS: number; readonly LevenbergMarquardt: number };
    SolveStatus: {
        readonly Success: number;
        readonly Converged: number;
        readonly Failed: number;
        readonly SuccessfulSolutionInvalid: number;
    };
}

/** Outcome of a sketch solve. */
export type SolverStatus = 'converged' | 'failed';

/** Structured result returned by {@link SketchSolver.solve}. */
export interface SolverResult {
    /** Whether the solver converged. */
    status: SolverStatus;
    /** Remaining degrees of freedom (0 = fully constrained). */
    dof: number;
    /** Caller-assigned ids of conflicting constraints, if any. */
    conflicting: string[];
    /** Caller-assigned ids of redundant constraints, if any. */
    redundant: string[];
}

/** A solved 2D point. */
export interface SketchPoint {
    type: 'point';
    id: string;
    x: number;
    y: number;
}

/** A solved 2D line segment. */
export interface SketchLine {
    type: 'line';
    id: string;
    p1Id: string;
    p2Id: string;
}

/** A solved 2D circle. */
export interface SketchCircle {
    type: 'circle';
    id: string;
    centerId: string;
    radius: number;
}

/** A solved 2D arc. */
export interface SketchArc {
    type: 'arc';
    id: string;
    centerId: string;
    radius: number;
    startAngle: number;
    endAngle: number;
    startId: string;
    endId: string;
}

/** Any geometry primitive returned by the solver. */
export type SketchPrimitive = SketchPoint | SketchLine | SketchCircle | SketchArc;

/** Options common to all constraints. */
export interface ConstraintOptions {
    /** When false the constraint is a reference/measurement (default true). */
    driving?: boolean;
}

/** Options for distance constraints. */
export interface DistanceConstraintOptions extends ConstraintOptions {
    /** Which distance variant to enforce (default 'point-point'). */
    direction?: 'point-point' | 'horizontal' | 'vertical';
}

/** A temporary constraint used during drag loops. */
export type TemporaryConstraint =
    | { type: 'fix'; id: string; pointId: string; x: number; y: number }
    | {
          type: 'distance';
          id: string;
          p1Id: string;
          p2Id: string;
          distance: number | string;
          direction?: 'point-point' | 'horizontal' | 'vertical';
      }
    | { type: 'horizontal'; id: string; lineId: string }
    | { type: 'vertical'; id: string; lineId: string };

/**
 * Solver-agnostic sketcher API.
 *
 * Implementations hide the underlying geometric constraint solver. Callers
 * assign stable ids to every primitive and constraint.
 */
export interface SketchSolver {
    /** Define or update a driving scalar parameter. */
    addParameter(name: string, value: number): void;
    /** Change the value of an existing parameter. */
    setParameter(name: string, value: number): void;
    /** Read the current value of a parameter. */
    getParameter(name: string): number | undefined;
    /** Remove a parameter. */
    removeParameter(name: string): void;

    /** Add a point. */
    addPoint(id: string, x: number, y: number, options?: { construction?: boolean }): void;
    /** Add a line through two existing points. */
    addLine(id: string, p1Id: string, p2Id: string, options?: { construction?: boolean }): void;
    /** Add a circle through an existing center point. */
    addCircle(id: string, centerId: string, radius: number, options?: { construction?: boolean }): void;
    /** Add an arc through an existing center and start/end points. */
    addArc(
        id: string,
        centerId: string,
        radius: number,
        startAngle: number,
        endAngle: number,
        startId: string,
        endId: string,
        options?: { construction?: boolean }
    ): void;

    addConstraintCoincident(id: string, p1Id: string, p2Id: string, options?: ConstraintOptions): void;
    addConstraintFix(id: string, pointId: string, options?: ConstraintOptions): void;
    addConstraintHorizontal(id: string, lineId: string, options?: ConstraintOptions): void;
    addConstraintVertical(id: string, lineId: string, options?: ConstraintOptions): void;
    addConstraintParallel(id: string, lineId1: string, lineId2: string, options?: ConstraintOptions): void;
    addConstraintPerpendicular(id: string, lineId1: string, lineId2: string, options?: ConstraintOptions): void;
    addConstraintTangent(id: string, primitiveId1: string, primitiveId2: string, options?: ConstraintOptions): void;
    addConstraintEqual(id: string, primitiveId1: string, primitiveId2: string, options?: ConstraintOptions): void;
    addConstraintConcentric(id: string, circleOrArc1: string, circleOrArc2: string, options?: ConstraintOptions): void;
    /**
     * Add a distance constraint.
     *
     * Point-point distance is the Euclidean distance and is always non-negative.
     * Horizontal/vertical distances are signed: the enforced value is
     * `primitiveId1.<coord> - primitiveId2.<coord>`. A positive value places
     * `primitiveId1` to the right/above `primitiveId2`; a negative value places
     * it to the left/below. This matches FreeCAD's signed distance convention.
     */
    addConstraintDistance(
        id: string,
        primitiveId1: string,
        primitiveId2: string,
        distance: number | string,
        options?: DistanceConstraintOptions
    ): void;
    addConstraintAngle(id: string, lineId1: string, lineId2: string, angle: number | string, options?: ConstraintOptions): void;
    addConstraintRadius(id: string, circleOrArcId: string, radius: number | string, options?: ConstraintOptions): void;
    addConstraintDiameter(id: string, circleOrArcId: string, diameter: number | string, options?: ConstraintOptions): void;
    addConstraintSymmetry(id: string, p1Id: string, p2Id: string, mirrorId: string, options?: ConstraintOptions): void;

    /** Remove a committed constraint by its caller-assigned id. */
    removeConstraint(id: string): void;

    /** Solve the committed sketch and update committed geometry. */
    solve(): Promise<SolverResult>;
    /** Solve with additional temporary constraints; does not mutate committed geometry. */
    pushTemporaryConstraints(constraints: TemporaryConstraint[]): Promise<SolverResult>;
    /** Discard temporary constraints and re-solve the committed sketch. */
    popTemporaryConstraints(): Promise<SolverResult>;

    /** Read back the last solved primitive by id. */
    getPrimitive(id: string): SketchPrimitive | undefined;
}

/** Options for creating the planegcs-backed solver. */
export interface PlanegcsSketchSolverOptions {
    /** locateFile passed to the emscripten module (useful in browsers). */
    locateFile?: (path: string) => string;
}

interface InternalPrimitive {
    type: 'point' | 'line' | 'circle' | 'arc';
    id: string;
    construction: boolean;
    pg: PgSketchGeometry;
}

interface InternalConstraint {
    id: string;
    pg: PgConstraint | PgConstraint[];
    driving: boolean;
    temporary: boolean;
}

function clonePrimitive(pg: PgSketchPrimitive): PgSketchPrimitive {
    return JSON.parse(JSON.stringify(pg)) as PgSketchPrimitive;
}

function isPgPoint(pg: PgSketchPrimitive): pg is PgSketchPoint {
    return pg.type === 'point';
}

function isPgLine(pg: PgSketchPrimitive): pg is PgSketchLine {
    return pg.type === 'line';
}

function isPgCircle(pg: PgSketchPrimitive): pg is PgSketchCircle {
    return pg.type === 'circle';
}

function isPgArc(pg: PgSketchPrimitive): pg is PgSketchArc {
    return pg.type === 'arc';
}

function resolveWasmPath(path: string): string {
    try {
        // Keep the import traceless for webpack: create the require dynamically.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require('module') as typeof import('module');
        const req = mod.createRequire(__filename);
        return req.resolve(`@salusoft89/planegcs/dist/planegcs_dist/${path}`);
    } catch {
        return path;
    }
}

/**
 * PlaneGCS-backed implementation of {@link SketchSolver}.
 *
 * The WASM module is loaded once per instance. Callers must invoke
 * {@link PlanegcsSketchSolver.create} so initialization can be awaited.
 */
export class PlanegcsSketchSolver implements SketchSolver {
    private readonly wrapper: PgGcsWrapper;
    private readonly enums: {
        Algorithm: { readonly DogLeg: number };
        SolveStatus: { readonly Success: number; readonly Converged: number };
    };
    private readonly params = new Map<string, number>();
    private readonly primitives = new Map<string, InternalPrimitive>();
    private readonly constraints = new Map<string, InternalConstraint>();
    private readonly temporaryConstraints = new Map<string, InternalConstraint>();
    private readonly fixes = new Map<string, string>();
    private readonly fixedPointIds = new Set<string>();
    private readonly lastSolved = new Map<string, SketchPrimitive>();
    private disposed = false;

    private constructor(
        wrapper: PgGcsWrapper,
        enums: { Algorithm: { readonly DogLeg: number }; SolveStatus: { readonly Success: number; readonly Converged: number } }
    ) {
        this.wrapper = wrapper;
        this.enums = enums;
    }

    /**
     * Create a solver instance.
     *
     * In Node the wasm file is resolved automatically from `node_modules`. In
     * the browser pass a `locateFile` callback that returns the URL of the wasm
     * asset.
     */
    static async create(options: PlanegcsSketchSolverOptions = {}): Promise<PlanegcsSketchSolver> {
        const locateFile = options.locateFile ?? ((path: string) => resolveWasmPath(path));
        const planegcs = (await import('@salusoft89/planegcs')) as unknown as PgModule;
        const module = await planegcs.init_planegcs_module({ locateFile });
        const gcs = new module.GcsSystem();
        return new PlanegcsSketchSolver(new planegcs.GcsWrapper(gcs, module), {
            Algorithm: planegcs.Algorithm,
            SolveStatus: planegcs.SolveStatus
        });
    }

    /** Release the underlying WASM module. Safe to call more than once. */
    destroy(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.wrapper.destroy_gcs_module();
    }

    private assertNotDisposed(): void {
        if (this.disposed) {
            throw new Error('PlanegcsSketchSolver has been destroyed');
        }
    }

    private assertFiniteNumber(value: number, name: string): void {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            throw new Error(`${name} must be a finite number, got ${value}`);
        }
    }

    private assertUniqueId(id: string, context: string): void {
        if (this.primitives.has(id) || this.constraints.has(id) || this.temporaryConstraints.has(id)) {
            throw new Error(`${context} id '${id}' is already in use`);
        }
    }

    private requirePrimitive(id: string, types: Array<'point' | 'line' | 'circle' | 'arc'>, context: string): InternalPrimitive {
        const primitive = this.primitives.get(id);
        if (!primitive) {
            throw new Error(`${context} references unknown primitive '${id}'`);
        }
        if (!types.includes(primitive.type)) {
            throw new Error(`${context} requires ${types.join('/')} but '${id}' is ${primitive.type}`);
        }
        return primitive;
    }

    addParameter(name: string, value: number): void {
        this.assertNotDisposed();
        this.assertFiniteNumber(value, `Parameter '${name}'`);
        this.params.set(name, value);
    }

    setParameter(name: string, value: number): void {
        this.assertNotDisposed();
        this.assertFiniteNumber(value, `Parameter '${name}'`);
        this.params.set(name, value);
    }

    getParameter(name: string): number | undefined {
        this.assertNotDisposed();
        return this.params.get(name);
    }

    removeParameter(name: string): void {
        this.assertNotDisposed();
        this.params.delete(name);
    }

    addPoint(id: string, x: number, y: number, options?: { construction?: boolean }): void {
        this.assertNotDisposed();
        this.assertUniqueId(id, 'Primitive');
        const pg: PgSketchPoint = {
            id,
            type: 'point',
            x,
            y,
            fixed: this.fixedPointIds.has(id)
        };
        this.primitives.set(id, { type: 'point', id, construction: options?.construction ?? false, pg });
    }

    addLine(id: string, p1Id: string, p2Id: string, options?: { construction?: boolean }): void {
        this.assertNotDisposed();
        this.assertUniqueId(id, 'Primitive');
        this.requirePrimitive(p1Id, ['point'], `Line '${id}' endpoint 1`);
        this.requirePrimitive(p2Id, ['point'], `Line '${id}' endpoint 2`);
        const pg: PgSketchLine = { id, type: 'line', p1_id: p1Id, p2_id: p2Id };
        this.primitives.set(id, { type: 'line', id, construction: options?.construction ?? false, pg });
    }

    addCircle(id: string, centerId: string, radius: number, options?: { construction?: boolean }): void {
        this.assertNotDisposed();
        this.assertUniqueId(id, 'Primitive');
        this.requirePrimitive(centerId, ['point'], `Circle '${id}' center`);
        const pg: PgSketchCircle = { id, type: 'circle', c_id: centerId, radius };
        this.primitives.set(id, { type: 'circle', id, construction: options?.construction ?? false, pg });
    }

    addArc(
        id: string,
        centerId: string,
        radius: number,
        startAngle: number,
        endAngle: number,
        startId: string,
        endId: string,
        options?: { construction?: boolean }
    ): void {
        this.assertNotDisposed();
        this.assertUniqueId(id, 'Primitive');
        this.requirePrimitive(centerId, ['point'], `Arc '${id}' center`);
        this.requirePrimitive(startId, ['point'], `Arc '${id}' start`);
        this.requirePrimitive(endId, ['point'], `Arc '${id}' end`);
        const pg: PgSketchArc = {
            id,
            type: 'arc',
            c_id: centerId,
            radius,
            start_angle: startAngle,
            end_angle: endAngle,
            start_id: startId,
            end_id: endId
        };
        this.primitives.set(id, { type: 'arc', id, construction: options?.construction ?? false, pg });
    }

    addConstraintCoincident(id: string, p1Id: string, p2Id: string, options?: ConstraintOptions): void {
        this.assertNotDisposed();
        this.assertUniqueId(id, 'Constraint');
        this.requirePrimitive(p1Id, ['point'], `Coincident constraint '${id}'`);
        this.requirePrimitive(p2Id, ['point'], `Coincident constraint '${id}'`);
        const pg: P2PCoincident = {
            id,
            type: 'p2p_coincident',
            p1_id: p1Id,
            p2_id: p2Id,
            driving: options?.driving ?? true
        };
        this.constraints.set(id, { id, pg, driving: pg.driving!, temporary: false });
    }

    addConstraintFix(id: string, pointId: string, _options?: ConstraintOptions): void {
        this.assertNotDisposed();
        this.assertUniqueId(id, 'Constraint');
        this.requirePrimitive(pointId, ['point'], `Fix constraint '${id}'`);
        this.fixedPointIds.add(pointId);
        this.fixes.set(id, pointId);
        // Fix constraints have no planegcs equivalent; store an empty payload so
        // the id participates in uniqueness checks and can be removed later.
        this.constraints.set(id, { id, pg: [], driving: true, temporary: false });
        // Re-emit the point so the fixed flag is picked up on next solve.
        const existing = this.primitives.get(pointId);
        if (existing && existing.type === 'point') {
            (existing.pg as PgSketchPoint).fixed = true;
        }
    }

    addConstraintHorizontal(id: string, lineId: string, options?: ConstraintOptions): void {
        this.assertNotDisposed();
        this.assertUniqueId(id, 'Constraint');
        this.requirePrimitive(lineId, ['line'], `Horizontal constraint '${id}'`);
        const pg: Horizontal_L = { id, type: 'horizontal_l', l_id: lineId, driving: options?.driving ?? true };
        this.constraints.set(id, { id, pg, driving: pg.driving!, temporary: false });
    }

    addConstraintVertical(id: string, lineId: string, options?: ConstraintOptions): void {
        this.assertNotDisposed();
        this.assertUniqueId(id, 'Constraint');
        this.requirePrimitive(lineId, ['line'], `Vertical constraint '${id}'`);
        const pg: Vertical_L = { id, type: 'vertical_l', l_id: lineId, driving: options?.driving ?? true };
        this.constraints.set(id, { id, pg, driving: pg.driving!, temporary: false });
    }

    addConstraintParallel(id: string, lineId1: string, lineId2: string, options?: ConstraintOptions): void {
        this.assertNotDisposed();
        this.assertUniqueId(id, 'Constraint');
        this.requirePrimitive(lineId1, ['line'], `Parallel constraint '${id}'`);
        this.requirePrimitive(lineId2, ['line'], `Parallel constraint '${id}'`);
        const pg: Parallel = { id, type: 'parallel', l1_id: lineId1, l2_id: lineId2, driving: options?.driving ?? true };
        this.constraints.set(id, { id, pg, driving: pg.driving!, temporary: false });
    }

    addConstraintPerpendicular(id: string, lineId1: string, lineId2: string, options?: ConstraintOptions): void {
        this.assertNotDisposed();
        this.assertUniqueId(id, 'Constraint');
        this.requirePrimitive(lineId1, ['line'], `Perpendicular constraint '${id}'`);
        this.requirePrimitive(lineId2, ['line'], `Perpendicular constraint '${id}'`);
        const pg: Perpendicular_LL = {
            id,
            type: 'perpendicular_ll',
            l1_id: lineId1,
            l2_id: lineId2,
            driving: options?.driving ?? true
        };
        this.constraints.set(id, { id, pg, driving: pg.driving!, temporary: false });
    }

    addConstraintTangent(id: string, primitiveId1: string, primitiveId2: string, options?: ConstraintOptions): void {
        this.assertNotDisposed();
        this.assertUniqueId(id, 'Constraint');
        const pg = this.makeTangentConstraint(id, primitiveId1, primitiveId2, options?.driving ?? true);
        this.constraints.set(id, { id, pg, driving: options?.driving ?? true, temporary: false });
    }

    addConstraintEqual(id: string, primitiveId1: string, primitiveId2: string, options?: ConstraintOptions): void {
        this.assertNotDisposed();
        this.assertUniqueId(id, 'Constraint');
        const pg = this.makeEqualConstraint(id, primitiveId1, primitiveId2, options?.driving ?? true);
        this.constraints.set(id, { id, pg, driving: options?.driving ?? true, temporary: false });
    }

    addConstraintConcentric(id: string, circleOrArc1: string, circleOrArc2: string, options?: ConstraintOptions): void {
        this.assertNotDisposed();
        this.assertUniqueId(id, 'Constraint');
        const c1 = this.requirePrimitive(circleOrArc1, ['circle', 'arc'], `Concentric constraint '${id}'`);
        const c2 = this.requirePrimitive(circleOrArc2, ['circle', 'arc'], `Concentric constraint '${id}'`);
        const center1 = (c1.pg as PgSketchCircle | PgSketchArc).c_id;
        const center2 = (c2.pg as PgSketchCircle | PgSketchArc).c_id;
        const pg: P2PCoincident = {
            id,
            type: 'p2p_coincident',
            p1_id: center1,
            p2_id: center2,
            driving: options?.driving ?? true
        };
        this.constraints.set(id, { id, pg, driving: pg.driving!, temporary: false });
    }

    addConstraintDistance(
        id: string,
        primitiveId1: string,
        primitiveId2: string,
        distance: number | string,
        options?: DistanceConstraintOptions
    ): void {
        this.assertNotDisposed();
        this.assertUniqueId(id, 'Constraint');
        const direction = options?.direction ?? 'point-point';
        const pg = this.makeDistanceConstraint(id, primitiveId1, primitiveId2, distance, direction, options?.driving ?? true);
        this.constraints.set(id, { id, pg, driving: options?.driving ?? true, temporary: false });
    }

    addConstraintAngle(id: string, lineId1: string, lineId2: string, angle: number | string, options?: ConstraintOptions): void {
        this.assertNotDisposed();
        this.assertUniqueId(id, 'Constraint');
        this.requirePrimitive(lineId1, ['line'], `Angle constraint '${id}'`);
        this.requirePrimitive(lineId2, ['line'], `Angle constraint '${id}'`);
        const pg: L2LAngle_LL = {
            id,
            type: 'l2l_angle_ll',
            l1_id: lineId1,
            l2_id: lineId2,
            angle,
            driving: options?.driving ?? true
        };
        this.constraints.set(id, { id, pg, driving: pg.driving!, temporary: false });
    }

    addConstraintRadius(id: string, circleOrArcId: string, radius: number | string, options?: ConstraintOptions): void {
        this.assertNotDisposed();
        this.assertUniqueId(id, 'Constraint');
        const primitive = this.requirePrimitive(circleOrArcId, ['circle', 'arc'], `Radius constraint '${id}'`);
        if (primitive.type === 'circle') {
            const pg: CircleRadius = { id, type: 'circle_radius', c_id: circleOrArcId, radius, driving: options?.driving ?? true };
            this.constraints.set(id, { id, pg, driving: pg.driving!, temporary: false });
        } else {
            const pg: ArcRadius = { id, type: 'arc_radius', a_id: circleOrArcId, radius, driving: options?.driving ?? true };
            this.constraints.set(id, { id, pg, driving: pg.driving!, temporary: false });
        }
    }

    addConstraintDiameter(id: string, circleOrArcId: string, diameter: number | string, options?: ConstraintOptions): void {
        this.assertNotDisposed();
        this.assertUniqueId(id, 'Constraint');
        const primitive = this.requirePrimitive(circleOrArcId, ['circle', 'arc'], `Diameter constraint '${id}'`);
        if (primitive.type === 'circle') {
            const pg: CircleDiameter = { id, type: 'circle_diameter', c_id: circleOrArcId, diameter, driving: options?.driving ?? true };
            this.constraints.set(id, { id, pg, driving: pg.driving!, temporary: false });
        } else {
            const pg: ArcDiameter = { id, type: 'arc_diameter', a_id: circleOrArcId, diameter, driving: options?.driving ?? true };
            this.constraints.set(id, { id, pg, driving: pg.driving!, temporary: false });
        }
    }

    addConstraintSymmetry(id: string, p1Id: string, p2Id: string, mirrorId: string, options?: ConstraintOptions): void {
        this.assertNotDisposed();
        this.assertUniqueId(id, 'Constraint');
        this.requirePrimitive(p1Id, ['point'], `Symmetry constraint '${id}'`);
        this.requirePrimitive(p2Id, ['point'], `Symmetry constraint '${id}'`);
        const mirror = this.requirePrimitive(mirrorId, ['point', 'line'], `Symmetry constraint '${id}' mirror`);
        const driving = options?.driving ?? true;
        if (mirror.type === 'line') {
            const pg: P2PSymmetric_PPL = {
                id,
                type: 'p2p_symmetric_ppl',
                p1_id: p1Id,
                p2_id: p2Id,
                l_id: mirrorId,
                driving
            };
            this.constraints.set(id, { id, pg, driving, temporary: false });
        } else if (mirror.type === 'point') {
            const pg: P2PSymmetric_PPP = {
                id,
                type: 'p2p_symmetric_ppp',
                p1_id: p1Id,
                p2_id: p2Id,
                p_id: mirrorId,
                driving
            };
            this.constraints.set(id, { id, pg, driving, temporary: false });
        } else {
            throw new Error(`Symmetry mirror ${mirrorId} must be a point or line`);
        }
    }

    removeConstraint(id: string): void {
        this.assertNotDisposed();
        const fixedPoint = this.fixes.get(id);
        if (fixedPoint) {
            this.fixedPointIds.delete(fixedPoint);
            const point = this.primitives.get(fixedPoint);
            if (point && point.type === 'point') {
                (point.pg as PgSketchPoint).fixed = false;
            }
            this.fixes.delete(id);
        }
        this.constraints.delete(id);
        this.temporaryConstraints.delete(id);
    }

    async solve(): Promise<SolverResult> {
        this.assertNotDisposed();
        const result = await this.runSolve([]);
        this.updateCommittedFromLastSolved();
        return result;
    }

    async pushTemporaryConstraints(constraints: TemporaryConstraint[]): Promise<SolverResult> {
        this.assertNotDisposed();
        for (const tc of constraints) {
            const internal = this.temporaryConstraintToInternal(tc);
            this.assertUniqueId(internal.id, 'Temporary constraint');
            for (const pg of Array.isArray(internal.pg) ? internal.pg : [internal.pg]) {
                this.assertUniqueId(pg.id, 'Temporary constraint');
            }
            this.temporaryConstraints.set(internal.id, internal);
        }
        return this.runSolve([...this.temporaryConstraints.values()]);
    }

    async popTemporaryConstraints(): Promise<SolverResult> {
        this.assertNotDisposed();
        this.temporaryConstraints.clear();
        const result = await this.runSolve([]);
        this.updateCommittedFromLastSolved();
        return result;
    }

    getPrimitive(id: string): SketchPrimitive | undefined {
        this.assertNotDisposed();
        return this.lastSolved.get(id);
    }

    private async runSolve(extraConstraints: InternalConstraint[]): Promise<SolverResult> {
        this.wrapper.clear_data();

        const objects: (PgSketchPrimitive | PgSketchParam)[] = [];
        for (const [name, value] of this.params.entries()) {
            objects.push({ type: 'param', name, value });
        }
        for (const p of this.primitives.values()) {
            if (p.type === 'point') {
                (p.pg as PgSketchPoint).fixed = this.fixedPointIds.has(p.id);
            }
            objects.push(clonePrimitive(p.pg));
        }
        for (const c of this.constraints.values()) {
            for (const pg of Array.isArray(c.pg) ? c.pg : [c.pg]) {
                objects.push(clonePrimitive(pg));
            }
        }
        for (const c of extraConstraints) {
            for (const pg of Array.isArray(c.pg) ? c.pg : [c.pg]) {
                const temp = clonePrimitive(pg) as PgConstraint;
                temp.temporary = true;
                objects.push(temp);
            }
        }

        this.wrapper.push_primitives_and_params(objects);
        const status = this.wrapper.solve(this.enums.Algorithm.DogLeg);
        const converged = status === this.enums.SolveStatus.Success || status === this.enums.SolveStatus.Converged;

        if (converged) {
            this.wrapper.apply_solution();
            this.lastSolved.clear();
            for (const pg of this.wrapper.sketch_index.get_primitives()) {
                const converted = this.convertToPublicPrimitive(pg);
                if (converted) {
                    this.lastSolved.set(converted.id, converted);
                }
            }
        }

        return {
            status: converged ? 'converged' : 'failed',
            dof: this.wrapper.gcs.dof(),
            conflicting: this.wrapper.get_gcs_conflicting_constraints(),
            redundant: this.wrapper.get_gcs_redundant_constraints()
        };
    }

    private updateCommittedFromLastSolved(): void {
        for (const [id, primitive] of this.primitives.entries()) {
            const solved = this.lastSolved.get(id);
            if (!solved) {
                continue;
            }
            if (primitive.type === 'point' && solved.type === 'point') {
                (primitive.pg as PgSketchPoint).x = solved.x;
                (primitive.pg as PgSketchPoint).y = solved.y;
            } else if (primitive.type === 'circle' && solved.type === 'circle') {
                (primitive.pg as PgSketchCircle).radius = solved.radius;
            } else if (primitive.type === 'arc' && solved.type === 'arc') {
                (primitive.pg as PgSketchArc).radius = solved.radius;
                (primitive.pg as PgSketchArc).start_angle = solved.startAngle;
                (primitive.pg as PgSketchArc).end_angle = solved.endAngle;
            }
            // Lines are defined by points; no per-line numeric state to update.
        }
    }

    private convertToPublicPrimitive(pg: PgSketchPrimitive): SketchPrimitive | undefined {
        if (isPgPoint(pg)) {
            return { type: 'point', id: pg.id, x: pg.x, y: pg.y };
        }
        if (isPgLine(pg)) {
            return { type: 'line', id: pg.id, p1Id: pg.p1_id, p2Id: pg.p2_id };
        }
        if (isPgCircle(pg)) {
            return { type: 'circle', id: pg.id, centerId: pg.c_id, radius: pg.radius };
        }
        if (isPgArc(pg)) {
            return {
                type: 'arc',
                id: pg.id,
                centerId: pg.c_id,
                radius: pg.radius,
                startAngle: pg.start_angle,
                endAngle: pg.end_angle,
                startId: pg.start_id,
                endId: pg.end_id
            };
        }
        return undefined;
    }

    private makeTangentConstraint(id: string, id1: string, id2: string, driving: boolean): PgConstraint {
        const p1 = this.primitives.get(id1);
        const p2 = this.primitives.get(id2);
        if (!p1 || !p2) {
            throw new Error(`Tangent constraint ${id} references unknown primitives`);
        }
        if (p1.type === 'line' && p2.type === 'circle') {
            const pg: Tangent_LC = { id, type: 'tangent_lc', l_id: id1, c_id: id2, driving };
            return pg;
        }
        if (p1.type === 'circle' && p2.type === 'line') {
            const pg: Tangent_LC = { id, type: 'tangent_lc', l_id: id2, c_id: id1, driving };
            return pg;
        }
        if (p1.type === 'line' && p2.type === 'arc') {
            const pg: Tangent_LA = { id, type: 'tangent_la', l_id: id1, a_id: id2, driving };
            return pg;
        }
        if (p1.type === 'arc' && p2.type === 'line') {
            const pg: Tangent_LA = { id, type: 'tangent_la', l_id: id2, a_id: id1, driving };
            return pg;
        }
        if (p1.type === 'circle' && p2.type === 'circle') {
            const pg: Tangent_CC = { id, type: 'tangent_cc', c1_id: id1, c2_id: id2, driving };
            return pg;
        }
        if (p1.type === 'arc' && p2.type === 'arc') {
            const pg: Tangent_AA = { id, type: 'tangent_aa', a1_id: id1, a2_id: id2, driving };
            return pg;
        }
        if (p1.type === 'circle' && p2.type === 'arc') {
            const pg: Tangent_CA = { id, type: 'tangent_ca', c_id: id1, a_id: id2, driving };
            return pg;
        }
        if (p1.type === 'arc' && p2.type === 'circle') {
            const pg: Tangent_CA = { id, type: 'tangent_ca', c_id: id2, a_id: id1, driving };
            return pg;
        }
        throw new Error(`Tangent constraint ${id} unsupported primitive combination ${p1.type}/${p2.type}`);
    }

    private makeEqualConstraint(id: string, id1: string, id2: string, driving: boolean): PgConstraint {
        const p1 = this.primitives.get(id1);
        const p2 = this.primitives.get(id2);
        if (!p1 || !p2) {
            throw new Error(`Equal constraint ${id} references unknown primitives`);
        }
        if (p1.type === 'line' && p2.type === 'line') {
            const pg: EqualLength = { id, type: 'equal_length', l1_id: id1, l2_id: id2, driving };
            return pg;
        }
        if (p1.type === 'circle' && p2.type === 'circle') {
            const pg: EqualRadius_CC = { id, type: 'equal_radius_cc', c1_id: id1, c2_id: id2, driving };
            return pg;
        }
        if (p1.type === 'arc' && p2.type === 'arc') {
            const pg: EqualRadius_AA = { id, type: 'equal_radius_aa', a1_id: id1, a2_id: id2, driving };
            return pg;
        }
        if ((p1.type === 'circle' && p2.type === 'arc') || (p1.type === 'arc' && p2.type === 'circle')) {
            const cId = p1.type === 'circle' ? id1 : id2;
            const aId = p1.type === 'arc' ? id1 : id2;
            const pg: EqualRadius_CA = { id, type: 'equal_radius_ca', c1_id: cId, a2_id: aId, driving };
            return pg;
        }
        // Generic equal: reference radius properties when comparing circles/arcs, length for lines.
        const prop1 = p1.type === 'line' ? 'length_not_supported' : 'radius';
        const prop2 = p2.type === 'line' ? 'length_not_supported' : 'radius';
        if (prop1 === 'length_not_supported' || prop2 === 'length_not_supported') {
            throw new Error(`Equal constraint ${id} unsupported primitive combination ${p1.type}/${p2.type}`);
        }
        const pg: Equal = {
            id,
            type: 'equal',
            param1: { o_id: id1, prop: 'radius' },
            param2: { o_id: id2, prop: 'radius' },
            driving
        };
        return pg;
    }

    private makeDistanceConstraint(
        id: string,
        id1: string,
        id2: string,
        distance: number | string,
        direction: 'point-point' | 'horizontal' | 'vertical',
        driving: boolean
    ): PgConstraint {
        const p1 = this.primitives.get(id1);
        const p2 = this.primitives.get(id2);
        if (!p1 || !p2) {
            throw new Error(`Distance constraint ${id} references unknown primitives`);
        }
        if (direction === 'point-point') {
            if (p1.type !== 'point' || p2.type !== 'point') {
                throw new Error(`Point-point distance ${id} requires two points`);
            }
            const pg: P2PDistance = { id, type: 'p2p_distance', p1_id: id1, p2_id: id2, distance, driving };
            return pg;
        }
        if (p1.type !== 'point' || p2.type !== 'point') {
            throw new Error(`Horizontal/vertical distance ${id} requires two points`);
        }
        // PlaneGCS Difference enforces param2 - param1 = difference. Swap the
        // operands so the public contract is primitiveId1.<coord> - primitiveId2.<coord>.
        const pg: Difference = {
            id,
            type: 'difference',
            param1: { o_id: id2, prop: direction === 'horizontal' ? 'x' : 'y' },
            param2: { o_id: id1, prop: direction === 'horizontal' ? 'x' : 'y' },
            difference: distance,
            driving
        };
        return pg;
    }

    private temporaryConstraintToInternal(tc: TemporaryConstraint): InternalConstraint {
        switch (tc.type) {
            case 'fix': {
                const cx: PgConstraint = {
                    id: `${tc.id}:x`,
                    type: 'coordinate_x',
                    p_id: tc.pointId,
                    x: tc.x,
                    driving: true,
                    temporary: true
                };
                const cy: PgConstraint = {
                    id: `${tc.id}:y`,
                    type: 'coordinate_y',
                    p_id: tc.pointId,
                    y: tc.y,
                    driving: true,
                    temporary: true
                };
                return { id: tc.id, pg: [cx, cy], driving: true, temporary: true };
            }
            case 'distance': {
                const pg = this.makeDistanceConstraint(tc.id, tc.p1Id, tc.p2Id, tc.distance, tc.direction ?? 'point-point', true);
                return { id: tc.id, pg, driving: true, temporary: true };
            }
            case 'horizontal': {
                this.requirePrimitive(tc.lineId, ['line'], `Temporary horizontal constraint '${tc.id}'`);
                const pg: Horizontal_L = { id: tc.id, type: 'horizontal_l', l_id: tc.lineId, driving: true, temporary: true };
                return { id: tc.id, pg, driving: true, temporary: true };
            }
            case 'vertical': {
                this.requirePrimitive(tc.lineId, ['line'], `Temporary vertical constraint '${tc.id}'`);
                const pg: Vertical_L = { id: tc.id, type: 'vertical_l', l_id: tc.lineId, driving: true, temporary: true };
                return { id: tc.id, pg, driving: true, temporary: true };
            }
        }
    }
}
