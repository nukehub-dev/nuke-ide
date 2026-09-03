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
 * `.nuke-cad` JSON document schema and validation.
 *
 * Version 2 introduces explicit bodies: every solid feature targets exactly one
 * body, labels attach to bodies, and boolean features (fuse/cut/common) combine
 * bodies. Version 1 documents are migrated automatically by adding one body per
 * additive feature and assigning subtractive features to the appropriate body.
 *
 * Version 3 adds a top-level ``curves`` array. Each curve stores its source
 * recipe (points, parametric expressions, or Fourier coefficients) plus a dense
 * polyline of samples that the backend consumes directly.
 *
 * @module nuke-cad/common
 */

import { validateTopologyRef, type TopologyRef } from './topology-refs';

/** Current `.nuke-cad` schema version. */
export const NUKE_CAD_SCHEMA_VERSION = 3;

/** Supported datum plane kinds. */
export type DatumKind = 'XY' | 'YZ' | 'XZ' | 'offset' | 'face';

/** A datum plane or face reference on which a sketch can be placed. */
export interface DatumPlane {
    id: string;
    kind: DatumKind;
    name: string;
    /** Offset distance for `offset` datums. */
    offset?: number;
    /** Topological face reference for `face` datums (sketch-on-face). */
    reference?: TopologyRef;
}

/** Supported dimension kinds. */
export type DimensionKind = 'distance' | 'distanceH' | 'distanceV' | 'angle' | 'radius' | 'diameter';

/**
 * First-class dimension metadata for a driving or reference dimension.
 *
 * Dimensions are stored alongside planegcs-verbatim constraints. The constraint
 * itself remains the solve source of truth; this record carries UI state such
 * as label position and the bound parameter name.
 */
export interface SketchDimension {
    id: string;
    /** Id of the planegcs-verbatim constraint driving this dimension. */
    constraintId: string;
    kind: DimensionKind;
    targetIds: string[];
    /** When false the dimension is a reference/measurement (default true). */
    driving: boolean;
    /** Optional sketch-local parameter name that drives the value. */
    parameter?: string;
    /** Current solved/reference value (always a finite number). */
    value: number;
    /** Optional 2D label offset from the default anchor in sketch units. */
    labelOffset?: [number, number];
}

/**
 * Sketch definition. Primitives and constraints are stored verbatim in the
 * planegcs JSON form so the solver adapter can load them without translation.
 */
export interface SketchDef {
    id: string;
    name: string;
    datumId: string;
    /** planegcs-verbatim primitives (points, lines, circles, arcs, ...). */
    primitives: Record<string, unknown>[];
    /** planegcs-verbatim constraints. */
    constraints: Record<string, unknown>[];
    /** Sketch-local named parameters referenced by constraint values. */
    parameters?: Record<string, number>;
    /** Dimension metadata (label position, parameter binding) for the UI. */
    dimensions?: SketchDimension[];
    /**
     * References to edges or faces of predecessor features that are projected
     * into the sketch plane as construction geometry. Projected primitives are
     * passed to the sketch builder with the ``construction`` flag set; they do
     * not become part of the sketch's output wires or faces.
     */
    externalRefs?: TopologyRef[];
}

/** A named, label-bearing body in the document. */
export interface BodyDef {
    id: string;
    name: string;
    /** Optional region-manifest label applied to all solids of this body. */
    label?: string;
}

/** A single point in 3D space used for curve samples. */
export type CurvePoint = readonly [number, number, number];

/** Source recipe for a curve defined by an explicit point list. */
export interface PointsCurveSource {
    readonly kind: 'points';
}

/** Source recipe for a parametric curve sampled uniformly in ``t``. */
export interface ParametricCurveSource {
    readonly kind: 'parametric';
    readonly x: string;
    readonly y: string;
    readonly z: string;
    readonly tStart: number;
    readonly tEnd: number;
    readonly sampleCount: number;
}

/** Source recipe for a Fourier-series curve sampled uniformly in ``theta``. */
export interface FourierCurveSource {
    readonly kind: 'fourier';
    readonly nfp: number;
    readonly order: number;
    readonly cosX: readonly number[];
    readonly sinX: readonly number[];
    readonly cosY: readonly number[];
    readonly sinY: readonly number[];
    readonly cosZ: readonly number[];
    readonly sinZ: readonly number[];
    readonly sampleCount: number;
}

/** Source description that produced a curve's stored samples. */
export type CurveSource = PointsCurveSource | ParametricCurveSource | FourierCurveSource;

/** A 3D curve stored in the document. */
export interface CurveDef {
    readonly id: string;
    readonly name: string;
    readonly source: CurveSource;
    readonly samples: readonly CurvePoint[];
}

/** Feature types for solid features. */
export type FeatureType =
    | 'pad'
    | 'pocket'
    | 'revolve'
    | 'groove'
    | 'sweep'
    | 'pipe'
    | 'loft'
    | 'helicalSweep'
    | 'fillet'
    | 'chamfer'
    | 'draft'
    | 'shell'
    | 'mirror'
    | 'linearPattern'
    | 'circularPattern'
    | 'booleanFuse'
    | 'booleanCut'
    | 'booleanCommon'
    | 'hole';

/** Feature types that create or modify solid geometry. */
export type SolidFeatureType =
    | 'pad'
    | 'pocket'
    | 'revolve'
    | 'groove'
    | 'sweep'
    | 'pipe'
    | 'loft'
    | 'helicalSweep'
    | 'fillet'
    | 'chamfer'
    | 'draft'
    | 'shell'
    | 'mirror'
    | 'linearPattern'
    | 'circularPattern'
    | 'booleanFuse'
    | 'booleanCut'
    | 'booleanCommon';

/** Parameters common to extrude-like features. */
export interface ExtrudeParams {
    length?: number;
    angle?: number;
    axis?: 'x' | 'y' | 'z';
    symmetric?: boolean;
    upToFace?: TopologyRef;
    upToBody?: string;
}

/** Parameters for revolve-like features. */
export interface RevolveParams {
    axis: 'x' | 'y' | 'z';
    angle: number;
}

/** Sweep path orientation modes. */
export type SweepOrientation = 'frenet' | 'fixedBinormal';

/** Parameters for a sweep: a sketch section swept along a curve path. */
export interface SweepParams {
    /** Path curve id (from the document's curves). */
    pathCurveId: string;
    /** Section frame behavior along the path. */
    orientation: SweepOrientation;
    /** Locked binormal direction; required iff orientation is 'fixedBinormal'. */
    binormal?: readonly [number, number, number];
}

/** Parameters for a pipe: a circular section swept along a curve path. */
export interface PipeParams {
    /** Path curve id (from the document's curves). */
    pathCurveId: string;
    /** Pipe radius; numeric only (unlike pad length, no parameter-name lookup). */
    radius: number;
    /** Section frame behavior along the path. */
    orientation: SweepOrientation;
    /** Locked binormal direction; required iff orientation is 'fixedBinormal'. */
    binormal?: readonly [number, number, number];
}

/** Parameters for a loft: ordered sketch sections joined into a single solid. */
export interface LoftParams {
    /** Ordered section sketch ids (>= 2); sections are used as positioned on their datums. */
    readonly sectionSketchIds: readonly string[];
    /** Ruled (straight) skin between sections; default false = smooth. */
    readonly ruled: boolean;
}

/** Parameters for a helical sweep: a sketch section swept along an analytic helix. */
export interface HelicalSweepParams {
    /** Origin-aligned helix axis. */
    readonly axis: 'X' | 'Y' | 'Z';
    /** Distance from the axis to the helix start; must be positive. */
    readonly startRadius: number;
    /** Axial rise per turn; must be positive. */
    readonly pitch: number;
    /** Number of turns; must be positive. Height = pitch * turns (derived, not stored). */
    readonly turns: number;
    /** Flip the winding direction; default false. */
    readonly leftHanded?: boolean;
    /** Section frame behavior along the helix; default 'fixedBinormal'. */
    readonly orientation: SweepOrientation;
    /** Locked binormal direction; defaults to the axis unit vector for 'fixedBinormal'. */
    readonly binormal?: readonly [number, number, number];
}

/** Parameters for fillet/chamfer. */
export interface FilletParams {
    edges: TopologyRef[];
    /** Fillet radius; required for fillet features. */
    radius?: number;
    /** Chamfer symmetric distance or distance+angle distance. */
    distance?: number;
    /** Chamfer two-distance mode. */
    distances?: [number, number];
    /** Chamfer distance+angle mode angle in degrees. */
    angle?: number;
}

/** Parameters for shell. */
export interface ShellParams {
    faces: TopologyRef[];
    thickness: number;
}

/** Parameters for draft. */
export interface DraftParams {
    faces: TopologyRef[];
    angle: number;
    pullDirection: [number, number, number];
}

/** Parameters for a linear pattern. */
export interface LinearPatternParams {
    /** Source sketch-based solid feature id (pad/pocket/revolve/groove). */
    source: string;
    count: number;
    /** Spacing between instances along the axis. */
    spacing: number;
    axis: 'x' | 'y' | 'z';
}

/** Parameters for a circular pattern. */
export interface CircularPatternParams {
    /** Source sketch-based solid feature id (pad/pocket/revolve/groove). */
    source: string;
    count: number;
    /** Total sweep angle in degrees; defaults to 360. */
    angle?: number;
    /** Axis through the origin; mutually exclusive with axisDatumId. */
    axis?: 'x' | 'y' | 'z';
    /** Datum axis id; mutually exclusive with axis. */
    axisDatumId?: string;
}

/** Parameters for a mirror feature. */
export interface MirrorParams {
    /** Source sketch-based solid feature id (pad/pocket/revolve/groove). */
    source: string;
    /** Coordinate plane; mutually exclusive with planeDatumId. */
    plane?: 'XY' | 'YZ' | 'XZ';
    /** Datum plane id; mutually exclusive with plane. */
    planeDatumId?: string;
}

/** Parameters for booleans. */
export interface BooleanParams {
    targetBody: string;
    toolBodies: string[];
    keepTools?: boolean;
}

/** Parameters for the hole wizard. */
export interface HoleParams {
    /** Placement face reference. */
    face: TopologyRef;
    /** Hole center in the placement face workplane coordinates. */
    center: [number, number];
    diameter: number;
    /** Omitted = through-hole. */
    depth?: number;
    counterboreDiameter?: number;
    counterboreDepth?: number;
    countersinkDiameter?: number;
    countersinkAngle?: number;
}

/** Union of all feature parameter shapes. */
export type FeatureParams =
    | ExtrudeParams
    | RevolveParams
    | SweepParams
    | PipeParams
    | LoftParams
    | HelicalSweepParams
    | FilletParams
    | ShellParams
    | DraftParams
    | LinearPatternParams
    | CircularPatternParams
    | MirrorParams
    | BooleanParams
    | HoleParams
    | Record<string, unknown>;

/** A parametric feature in the model tree. */
export interface FeatureDef {
    id: string;
    name: string;
    type: FeatureType;
    /** Body this feature creates or modifies. */
    body: string;
    /** Sketch consumed by the feature (implied dependency). */
    sketchId?: string;
    /** Feature-specific parameters. */
    params: FeatureParams;
    /** When true the feature is excluded from the build. */
    suppressed: boolean;
    /** Explicit upstream feature dependencies (in addition to sketchId). */
    dependsOn: string[];
}

/** Complete `.nuke-cad` document. */
export interface NukeCadDocument {
    version: number;
    name: string;
    parameters: Record<string, number>;
    datums: DatumPlane[];
    bodies: BodyDef[];
    sketches: SketchDef[];
    features: FeatureDef[];
    curves: CurveDef[];
}

/** A single validation issue. */
export interface ValidationIssue {
    path: string;
    message: string;
}

/** Result of {@link validateNukeCadDocument}. */
export interface ValidationResult {
    valid: boolean;
    issues: ValidationIssue[];
}

interface MutableValidationContext {
    issues: ValidationIssue[];
    ids: Set<string>;
}

function issue(ctx: MutableValidationContext, path: string, message: string): void {
    ctx.issues.push({ path, message });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isString(value: unknown): value is string {
    return typeof value === 'string';
}

function validateEmbeddedTopologyRef(ctx: MutableValidationContext, path: string, value: unknown): void {
    if (!isPlainObject(value)) {
        issue(ctx, path, 'expected a TopologyRef object');
        return;
    }
    const result = validateTopologyRef(value as unknown as TopologyRef);
    for (const sub of result.issues) {
        issue(ctx, path, sub);
    }
}

function requireId(ctx: MutableValidationContext, path: string, id: unknown): string | undefined {
    if (!isString(id) || id.length === 0) {
        issue(ctx, path, 'missing or invalid id');
        return undefined;
    }
    if (ctx.ids.has(id)) {
        issue(ctx, path, `duplicate id '${id}'`);
        return id;
    }
    ctx.ids.add(id);
    return id;
}

function validateDatum(ctx: MutableValidationContext, datum: DatumPlane, index: number): void {
    const path = `datums[${index}]`;
    requireId(ctx, `${path}.id`, datum.id);
    if (!isString(datum.name)) {
        issue(ctx, `${path}.name`, 'name must be a string');
    }
    const kinds: DatumKind[] = ['XY', 'YZ', 'XZ', 'offset', 'face'];
    if (!kinds.includes(datum.kind)) {
        issue(ctx, `${path}.kind`, `unknown datum kind '${datum.kind}'`);
    }
    if (datum.kind === 'offset' && datum.offset !== undefined && !isFiniteNumber(datum.offset)) {
        issue(ctx, `${path}.offset`, 'offset must be a finite number');
    }
    if (datum.kind === 'face') {
        if (datum.reference === undefined) {
            issue(ctx, `${path}.reference`, 'face datum requires a reference');
        } else {
            validateEmbeddedTopologyRef(ctx, `${path}.reference`, datum.reference);
        }
    }
}

function validateBody(ctx: MutableValidationContext, body: BodyDef, index: number): void {
    const path = `bodies[${index}]`;
    requireId(ctx, `${path}.id`, body.id);
    if (!isString(body.name)) {
        issue(ctx, `${path}.name`, 'name must be a string');
    }
    if (body.label !== undefined && !isString(body.label)) {
        issue(ctx, `${path}.label`, 'label must be a string when present');
    }
}

function validateSketch(ctx: MutableValidationContext, sketch: SketchDef, index: number): void {
    const path = `sketches[${index}]`;
    requireId(ctx, `${path}.id`, sketch.id);
    if (!isString(sketch.name)) {
        issue(ctx, `${path}.name`, 'name must be a string');
    }
    if (!isString(sketch.datumId)) {
        issue(ctx, `${path}.datumId`, 'datumId must be a string');
    }
    if (sketch.externalRefs !== undefined) {
        if (!Array.isArray(sketch.externalRefs)) {
            issue(ctx, `${path}.externalRefs`, 'externalRefs must be an array of TopologyRefs');
        } else {
            for (const [i, ref] of sketch.externalRefs.entries()) {
                validateEmbeddedTopologyRef(ctx, `${path}.externalRefs[${i}]`, ref);
            }
        }
    }
    const localParamNames = new Set<string>();
    if (sketch.parameters) {
        for (const [name, value] of Object.entries(sketch.parameters)) {
            if (!isFiniteNumber(value)) {
                issue(ctx, `${path}.parameters.${name}`, 'parameter value must be finite');
            }
            localParamNames.add(name);
        }
    }
    const primitiveIds = new Set<string>();
    for (const [i, primitive] of sketch.primitives.entries()) {
        const ppath = `${path}.primitives[${i}]`;
        if (!isPlainObject(primitive)) {
            issue(ctx, ppath, 'primitive must be an object');
            continue;
        }
        const pid = primitive.id;
        if (!isString(pid) || pid.length === 0) {
            issue(ctx, `${ppath}.id`, 'primitive must have a string id');
        } else if (primitiveIds.has(pid)) {
            issue(ctx, `${ppath}.id`, `duplicate primitive id '${pid}' in sketch`);
        } else {
            primitiveIds.add(pid);
        }
    }
    const constraintIds = new Set<string>();
    for (const [i, constraint] of sketch.constraints.entries()) {
        const cpath = `${path}.constraints[${i}]`;
        if (!isPlainObject(constraint)) {
            issue(ctx, cpath, 'constraint must be an object');
            continue;
        }
        const cid = constraint.id;
        if (!isString(cid) || cid.length === 0) {
            issue(ctx, `${cpath}.id`, 'constraint must have a string id');
        } else if (constraintIds.has(cid)) {
            issue(ctx, `${cpath}.id`, `duplicate constraint id '${cid}' in sketch`);
        } else if (primitiveIds.has(cid)) {
            issue(ctx, `${cpath}.id`, `constraint id '${cid}' collides with a primitive id in sketch`);
        } else {
            constraintIds.add(cid);
        }
    }
    const dimensionIds = new Set<string>();
    const knownDimensionKinds: DimensionKind[] = ['distance', 'distanceH', 'distanceV', 'angle', 'radius', 'diameter'];
    for (const [i, dimension] of (sketch.dimensions ?? []).entries()) {
        const dpath = `${path}.dimensions[${i}]`;
        if (!isPlainObject(dimension)) {
            issue(ctx, dpath, 'dimension must be an object');
            continue;
        }
        const did = dimension.id;
        if (!isString(did) || did.length === 0) {
            issue(ctx, `${dpath}.id`, 'dimension must have a string id');
        } else if (dimensionIds.has(did)) {
            issue(ctx, `${dpath}.id`, `duplicate dimension id '${did}' in sketch`);
        } else if (primitiveIds.has(did) || constraintIds.has(did)) {
            issue(ctx, `${dpath}.id`, `dimension id '${did}' collides with another id in sketch`);
        } else {
            dimensionIds.add(did);
        }
        if (!isString(dimension.constraintId) || dimension.constraintId.length === 0) {
            issue(ctx, `${dpath}.constraintId`, 'dimension must reference a constraint id');
        } else if (!constraintIds.has(dimension.constraintId)) {
            issue(ctx, `${dpath}.constraintId`, `dimension references unknown constraint '${dimension.constraintId}'`);
        }
        if (!knownDimensionKinds.includes(dimension.kind as DimensionKind)) {
            issue(ctx, `${dpath}.kind`, `unknown dimension kind '${dimension.kind}'`);
        }
        if (!Array.isArray(dimension.targetIds) || dimension.targetIds.length === 0) {
            issue(ctx, `${dpath}.targetIds`, 'dimension targetIds must be a non-empty array');
        } else {
            for (const [j, tid] of dimension.targetIds.entries()) {
                if (!isString(tid) || tid.length === 0) {
                    issue(ctx, `${dpath}.targetIds[${j}]`, 'target id must be a string');
                } else if (!primitiveIds.has(tid)) {
                    issue(ctx, `${dpath}.targetIds[${j}]`, `dimension target '${tid}' is not a primitive id in the sketch`);
                }
            }
        }
        if (typeof dimension.driving !== 'boolean') {
            issue(ctx, `${dpath}.driving`, 'dimension driving flag must be a boolean');
        }
        if (dimension.parameter !== undefined && !isString(dimension.parameter)) {
            issue(ctx, `${dpath}.parameter`, 'dimension parameter must be a string when present');
        }
        if (!isFiniteNumber(dimension.value)) {
            issue(ctx, `${dpath}.value`, 'dimension value must be a finite number');
        }
        if (dimension.labelOffset !== undefined) {
            if (!Array.isArray(dimension.labelOffset) || dimension.labelOffset.length !== 2) {
                issue(ctx, `${dpath}.labelOffset`, 'labelOffset must be a [x, y] tuple');
            } else {
                for (const [j, v] of dimension.labelOffset.entries()) {
                    if (!isFiniteNumber(v)) {
                        issue(ctx, `${dpath}.labelOffset[${j}]`, 'labelOffset component must be finite');
                    }
                }
            }
        }
    }
}

function validateFeature(ctx: MutableValidationContext, feature: FeatureDef, index: number): void {
    const path = `features[${index}]`;
    requireId(ctx, `${path}.id`, feature.id);
    if (!isString(feature.name)) {
        issue(ctx, `${path}.name`, 'name must be a string');
    }
    const knownTypes: FeatureType[] = [
        'pad',
        'pocket',
        'revolve',
        'groove',
        'sweep',
        'pipe',
        'loft',
        'helicalSweep',
        'fillet',
        'chamfer',
        'draft',
        'shell',
        'mirror',
        'linearPattern',
        'circularPattern',
        'booleanFuse',
        'booleanCut',
        'booleanCommon',
        'hole'
    ];
    if (!knownTypes.includes(feature.type)) {
        issue(ctx, `${path}.type`, `unknown feature type '${feature.type}'`);
    }
    if (!isString(feature.body) || feature.body.length === 0) {
        issue(ctx, `${path}.body`, 'body must be a non-empty string');
    }
    if ('label' in feature) {
        issue(ctx, `${path}.label`, 'feature-level label is removed in schema v2; assign labels to bodies instead (migrate from v1)');
    }
    if (feature.sketchId !== undefined && !isString(feature.sketchId)) {
        issue(ctx, `${path}.sketchId`, 'sketchId must be a string when present');
    }
    if (feature.params === undefined) {
        issue(ctx, `${path}.params`, 'params object is required');
    } else if (!isPlainObject(feature.params)) {
        issue(ctx, `${path}.params`, 'params must be an object');
    } else {
        validateFeatureParams(ctx, `${path}.params`, feature.type, feature.params);
    }
    if (!Array.isArray(feature.dependsOn)) {
        issue(ctx, `${path}.dependsOn`, 'dependsOn must be an array');
    } else {
        const seenDeps = new Set<string>();
        for (const [i, dep] of feature.dependsOn.entries()) {
            if (!isString(dep)) {
                issue(ctx, `${path}.dependsOn[${i}]`, 'dependency must be a feature id string');
            } else if (dep === feature.id) {
                issue(ctx, `${path}.dependsOn[${i}]`, 'feature cannot depend on itself');
            } else if (seenDeps.has(dep)) {
                issue(ctx, `${path}.dependsOn[${i}]`, `duplicate dependency '${dep}'`);
            } else {
                seenDeps.add(dep);
            }
        }
    }
}

/** Validate a sweep/pipe path orientation and its binormal requirement. */
function validateSweepOrientation(ctx: MutableValidationContext, path: string, p: Record<string, unknown>): void {
    if (p.orientation !== 'frenet' && p.orientation !== 'fixedBinormal') {
        issue(ctx, `${path}.orientation`, "orientation must be 'frenet' or 'fixedBinormal'");
        return;
    }
    const binormal = p.binormal;
    if (p.orientation === 'fixedBinormal') {
        const isNonZeroVector =
            Array.isArray(binormal) &&
            binormal.length === 3 &&
            binormal.every((v: unknown) => isFiniteNumber(v)) &&
            !(binormal[0] === 0 && binormal[1] === 0 && binormal[2] === 0);
        if (!isNonZeroVector) {
            issue(ctx, `${path}.binormal`, 'fixedBinormal requires a non-zero binormal [x, y, z]');
        }
    } else if (binormal !== undefined) {
        const isVector = Array.isArray(binormal) && binormal.length === 3 && binormal.every((v: unknown) => isFiniteNumber(v));
        if (!isVector) {
            issue(ctx, `${path}.binormal`, 'binormal must be a [x, y, z] tuple of finite numbers');
        }
    }
}

function validateFeatureParams(ctx: MutableValidationContext, path: string, type: FeatureType, params: FeatureParams): void {
    const p = params as Record<string, unknown>;
    switch (type) {
        case 'pad':
        case 'pocket':
            if (!isFiniteNumber(p.length) || p.length <= 0) {
                issue(ctx, `${path}.length`, 'length is required and must be a positive finite number');
            }
            if (p.angle !== undefined && (!isFiniteNumber(p.angle) || p.angle < -360 || p.angle > 360)) {
                issue(ctx, `${path}.angle`, 'draft angle must be between -360 and 360 degrees');
            }
            if (p.upToFace !== undefined) {
                validateEmbeddedTopologyRef(ctx, `${path}.upToFace`, p.upToFace);
            }
            break;
        case 'revolve':
        case 'groove': {
            const axis = p.axis;
            if (axis !== 'x' && axis !== 'y' && axis !== 'z') {
                issue(ctx, `${path}.axis`, "axis must be 'x', 'y' or 'z'");
            }
            if (!isFiniteNumber(p.angle) || p.angle <= 0 || p.angle > 360) {
                issue(ctx, `${path}.angle`, 'revolve angle is required and must be in (0, 360] degrees');
            }
            break;
        }
        case 'sweep':
            if (!isString(p.pathCurveId) || p.pathCurveId.length === 0) {
                issue(ctx, `${path}.pathCurveId`, 'pathCurveId is required and must be a non-empty string');
            }
            validateSweepOrientation(ctx, path, p);
            break;
        case 'pipe':
            if (!isString(p.pathCurveId) || p.pathCurveId.length === 0) {
                issue(ctx, `${path}.pathCurveId`, 'pathCurveId is required and must be a non-empty string');
            }
            if (!isFiniteNumber(p.radius) || p.radius <= 0) {
                issue(ctx, `${path}.radius`, 'pipe requires a positive finite radius');
            }
            validateSweepOrientation(ctx, path, p);
            break;
        case 'loft': {
            const sectionSketchIds = p.sectionSketchIds;
            if (!Array.isArray(sectionSketchIds) || sectionSketchIds.length < 2) {
                issue(ctx, `${path}.sectionSketchIds`, 'loft requires at least 2 section sketch ids');
            } else {
                const seen = new Set<string>();
                for (const [i, sid] of sectionSketchIds.entries()) {
                    if (!isString(sid) || sid.length === 0) {
                        issue(ctx, `${path}.sectionSketchIds[${i}]`, 'section sketch id must be a non-empty string');
                    } else if (seen.has(sid)) {
                        issue(ctx, `${path}.sectionSketchIds[${i}]`, `duplicate section sketch id '${sid}'`);
                    } else {
                        seen.add(sid);
                    }
                }
            }
            if (typeof p.ruled !== 'boolean') {
                issue(ctx, `${path}.ruled`, 'ruled must be a boolean');
            }
            break;
        }
        case 'helicalSweep': {
            if (p.axis !== 'X' && p.axis !== 'Y' && p.axis !== 'Z') {
                issue(ctx, `${path}.axis`, "axis must be 'X', 'Y' or 'Z'");
            }
            for (const name of ['startRadius', 'pitch', 'turns'] as const) {
                if (!isFiniteNumber(p[name]) || (p[name] as number) <= 0) {
                    issue(ctx, `${path}.${name}`, `${name} is required and must be a positive finite number`);
                }
            }
            if (p.leftHanded !== undefined && typeof p.leftHanded !== 'boolean') {
                issue(ctx, `${path}.leftHanded`, 'leftHanded must be a boolean when present');
            }
            if (p.orientation !== 'frenet' && p.orientation !== 'fixedBinormal') {
                issue(ctx, `${path}.orientation`, "orientation must be 'frenet' or 'fixedBinormal'");
            } else if (p.orientation === 'fixedBinormal' && p.binormal !== undefined) {
                // Unlike sweep, a fixedBinormal helical sweep may omit the binormal
                // (it defaults to the axis unit vector); when present it must be non-zero.
                const binormal = p.binormal;
                const isNonZeroVector =
                    Array.isArray(binormal) &&
                    binormal.length === 3 &&
                    binormal.every((v: unknown) => isFiniteNumber(v)) &&
                    !(binormal[0] === 0 && binormal[1] === 0 && binormal[2] === 0);
                if (!isNonZeroVector) {
                    issue(ctx, `${path}.binormal`, 'binormal must be a non-zero [x, y, z] vector');
                }
            } else if (p.binormal !== undefined) {
                const isVector =
                    Array.isArray(p.binormal) && p.binormal.length === 3 && p.binormal.every((v: unknown) => isFiniteNumber(v));
                if (!isVector) {
                    issue(ctx, `${path}.binormal`, 'binormal must be a [x, y, z] tuple of finite numbers');
                }
            }
            break;
        }
        case 'fillet':
            if (!Array.isArray(p.edges) || p.edges.length === 0) {
                issue(ctx, `${path}.edges`, 'edges must be a non-empty array of TopologyRefs');
            } else {
                for (const [i, edge] of p.edges.entries()) {
                    validateEmbeddedTopologyRef(ctx, `${path}.edges[${i}]`, edge);
                }
            }
            if (!isFiniteNumber(p.radius) || p.radius <= 0) {
                issue(ctx, `${path}.radius`, 'fillet requires a positive radius');
            }
            break;
        case 'chamfer':
            if (!Array.isArray(p.edges) || p.edges.length === 0) {
                issue(ctx, `${path}.edges`, 'edges must be a non-empty array of TopologyRefs');
            } else {
                for (const [i, edge] of p.edges.entries()) {
                    validateEmbeddedTopologyRef(ctx, `${path}.edges[${i}]`, edge);
                }
            }
            {
                const hasDistance = isFiniteNumber(p.distance) && p.distance > 0;
                const hasDistances =
                    Array.isArray(p.distances) &&
                    p.distances.length === 2 &&
                    p.distances.every((d: unknown) => isFiniteNumber(d) && (d as number) > 0);
                const hasAngle = isFiniteNumber(p.angle) && p.angle > 0 && p.angle < 90;
                if (!hasDistance && !hasDistances) {
                    issue(ctx, `${path}.distance`, 'chamfer requires distance or distances');
                }
                if (hasDistances && (p.distance !== undefined || p.angle !== undefined)) {
                    issue(ctx, `${path}.distances`, 'distances is mutually exclusive with distance/angle');
                }
                if (p.angle !== undefined && !hasAngle) {
                    issue(ctx, `${path}.angle`, 'chamfer angle must be in (0, 90) degrees');
                }
                if (hasAngle && !hasDistance) {
                    issue(ctx, `${path}.distance`, 'chamfer angle requires distance');
                }
            }
            break;
        case 'shell':
            if (!Array.isArray(p.faces)) {
                issue(ctx, `${path}.faces`, 'faces must be an array of TopologyRefs');
            } else {
                for (const [i, face] of p.faces.entries()) {
                    validateEmbeddedTopologyRef(ctx, `${path}.faces[${i}]`, face);
                }
            }
            if (!isFiniteNumber(p.thickness) || p.thickness <= 0) {
                issue(ctx, `${path}.thickness`, 'shell requires a positive thickness');
            }
            break;
        case 'draft':
            if (!Array.isArray(p.faces) || p.faces.length === 0) {
                issue(ctx, `${path}.faces`, 'faces must be a non-empty array of TopologyRefs');
            } else {
                for (const [i, face] of p.faces.entries()) {
                    validateEmbeddedTopologyRef(ctx, `${path}.faces[${i}]`, face);
                }
            }
            if (!isFiniteNumber(p.angle) || p.angle <= -90 || p.angle >= 90) {
                issue(ctx, `${path}.angle`, 'draft requires an angle in (-90, 90) degrees');
            }
            {
                const dir = p.pullDirection;
                const isNonZeroVector =
                    Array.isArray(dir) &&
                    dir.length === 3 &&
                    dir.every((v: unknown) => isFiniteNumber(v)) &&
                    !(dir[0] === 0 && dir[1] === 0 && dir[2] === 0);
                if (!isNonZeroVector) {
                    issue(ctx, `${path}.pullDirection`, 'draft requires a non-zero pullDirection [x, y, z]');
                }
            }
            break;
        case 'linearPattern': {
            if (!isString(p.source) || p.source.length === 0) {
                issue(ctx, `${path}.source`, 'source is required and must be a feature id');
            }
            if (!Number.isInteger(p.count) || (p.count as number) < 1) {
                issue(ctx, `${path}.count`, 'count is required and must be a positive integer');
            }
            if (!isFiniteNumber(p.spacing) || p.spacing === 0) {
                issue(ctx, `${path}.spacing`, 'spacing is required and must be a non-zero finite number');
            }
            if (p.axis !== 'x' && p.axis !== 'y' && p.axis !== 'z') {
                issue(ctx, `${path}.axis`, "axis must be 'x', 'y' or 'z'");
            }
            break;
        }
        case 'circularPattern': {
            if (!isString(p.source) || p.source.length === 0) {
                issue(ctx, `${path}.source`, 'source is required and must be a feature id');
            }
            if (!Number.isInteger(p.count) || (p.count as number) < 1) {
                issue(ctx, `${path}.count`, 'count is required and must be a positive integer');
            }
            const hasAxis = p.axis === 'x' || p.axis === 'y' || p.axis === 'z';
            const hasAxisDatum = isString(p.axisDatumId) && p.axisDatumId.length > 0;
            if (!hasAxis && !hasAxisDatum) {
                issue(ctx, `${path}.axis`, "circular pattern requires axis 'x'/'y'/'z' or axisDatumId");
            }
            if (hasAxis && hasAxisDatum) {
                issue(ctx, `${path}.axis`, 'axis and axisDatumId are mutually exclusive');
            }
            if (p.angle !== undefined && (!isFiniteNumber(p.angle) || p.angle <= 0 || p.angle > 360)) {
                issue(ctx, `${path}.angle`, 'angle must be in (0, 360] degrees');
            }
            if (p.angle !== undefined && p.angle !== 360 && (p.count as number) < 2) {
                issue(ctx, `${path}.count`, 'partial sweep requires count >= 2');
            }
            break;
        }
        case 'mirror': {
            if (!isString(p.source) || p.source.length === 0) {
                issue(ctx, `${path}.source`, 'source is required and must be a feature id');
            }
            const hasPlane = p.plane === 'XY' || p.plane === 'YZ' || p.plane === 'XZ';
            const hasPlaneDatum = isString(p.planeDatumId) && p.planeDatumId.length > 0;
            if (!hasPlane && !hasPlaneDatum) {
                issue(ctx, `${path}.plane`, "mirror requires plane 'XY'/'YZ'/'XZ' or planeDatumId");
            }
            if (hasPlane && hasPlaneDatum) {
                issue(ctx, `${path}.plane`, 'plane and planeDatumId are mutually exclusive');
            }
            break;
        }
        case 'booleanFuse':
        case 'booleanCut':
        case 'booleanCommon': {
            if (!isString(p.targetBody) || p.targetBody.length === 0) {
                issue(ctx, `${path}.targetBody`, 'targetBody is required and must be a non-empty string');
            }
            if (!Array.isArray(p.toolBodies) || p.toolBodies.length === 0) {
                issue(ctx, `${path}.toolBodies`, 'toolBodies is required and must be a non-empty array of body ids');
            } else {
                const seen = new Set<string>();
                for (const [i, tool] of p.toolBodies.entries()) {
                    if (!isString(tool) || tool.length === 0) {
                        issue(ctx, `${path}.toolBodies[${i}]`, 'tool body id must be a non-empty string');
                    } else if (seen.has(tool)) {
                        issue(ctx, `${path}.toolBodies[${i}]`, `duplicate tool body id '${tool}'`);
                    } else {
                        seen.add(tool);
                    }
                }
            }
            if (p.keepTools !== undefined && typeof p.keepTools !== 'boolean') {
                issue(ctx, `${path}.keepTools`, 'keepTools must be a boolean when present');
            }
            break;
        }
        case 'hole': {
            if (!isPlainObject(p.face)) {
                issue(ctx, `${path}.face`, 'face is required and must be a TopologyRef');
            } else {
                validateEmbeddedTopologyRef(ctx, `${path}.face`, p.face);
            }
            const center = p.center;
            if (!Array.isArray(center) || center.length !== 2 || !center.every((v: unknown) => isFiniteNumber(v))) {
                issue(ctx, `${path}.center`, 'center is required and must be a [u, v] tuple of finite numbers');
            }
            if (!isFiniteNumber(p.diameter) || p.diameter <= 0) {
                issue(ctx, `${path}.diameter`, 'diameter is required and must be a positive finite number');
            }
            if (p.depth !== undefined && (!isFiniteNumber(p.depth) || p.depth <= 0)) {
                issue(ctx, `${path}.depth`, 'depth must be a positive finite number when present');
            }
            const hasCounterbore = p.counterboreDiameter !== undefined || p.counterboreDepth !== undefined;
            const hasCountersink = p.countersinkDiameter !== undefined || p.countersinkAngle !== undefined;
            if (hasCounterbore && hasCountersink) {
                issue(ctx, `${path}.counterboreDiameter`, 'counterbore and countersink are mutually exclusive');
            }
            if (hasCounterbore) {
                if (!isFiniteNumber(p.counterboreDiameter) || (p.counterboreDiameter as number) <= 0) {
                    issue(ctx, `${path}.counterboreDiameter`, 'counterboreDiameter must be positive');
                }
                if (!isFiniteNumber(p.counterboreDepth) || (p.counterboreDepth as number) <= 0) {
                    issue(ctx, `${path}.counterboreDepth`, 'counterboreDepth must be positive');
                }
            }
            if (hasCountersink) {
                if (!isFiniteNumber(p.countersinkDiameter) || (p.countersinkDiameter as number) <= 0) {
                    issue(ctx, `${path}.countersinkDiameter`, 'countersinkDiameter must be positive');
                }
                if (!isFiniteNumber(p.countersinkAngle) || (p.countersinkAngle as number) <= 0 || (p.countersinkAngle as number) >= 90) {
                    issue(ctx, `${path}.countersinkAngle`, 'countersinkAngle must be in (0, 90) degrees');
                }
            }
            break;
        }
    }
}

function validateCurvePoint(ctx: MutableValidationContext, path: string, point: unknown): boolean {
    if (!Array.isArray(point) || point.length !== 3) {
        issue(ctx, path, 'curve sample must be a [x, y, z] tuple');
        return false;
    }
    for (const [i, v] of point.entries()) {
        if (!isFiniteNumber(v)) {
            issue(ctx, `${path}[${i}]`, 'curve sample coordinate must be finite');
            return false;
        }
    }
    return true;
}

function validateNumberArray(
    ctx: MutableValidationContext,
    path: string,
    value: unknown,
    expectedLength: number | undefined,
    allowShorter = false
): void {
    if (!Array.isArray(value)) {
        issue(ctx, path, 'expected an array of finite numbers');
        return;
    }
    if (expectedLength !== undefined && (allowShorter ? value.length > expectedLength : value.length !== expectedLength)) {
        issue(ctx, path, `expected array of length ${allowShorter ? 'at most ' : ''}${expectedLength}, got ${value.length}`);
        return;
    }
    for (const [i, v] of value.entries()) {
        if (!isFiniteNumber(v)) {
            issue(ctx, `${path}[${i}]`, 'coefficient must be a finite number');
        }
    }
}

function validateCurve(ctx: MutableValidationContext, curve: CurveDef, index: number): void {
    const path = `curves[${index}]`;
    requireId(ctx, `${path}.id`, curve.id);
    if (!isString(curve.name)) {
        issue(ctx, `${path}.name`, 'name must be a string');
    }
    if (!isPlainObject(curve.source)) {
        issue(ctx, `${path}.source`, 'source must be an object');
    } else {
        const source = curve.source as Record<string, unknown>;
        const kind = source.kind;
        if (kind !== 'points' && kind !== 'parametric' && kind !== 'fourier') {
            issue(ctx, `${path}.source.kind`, `unknown curve source kind '${kind}'`);
        }
        if (kind === 'parametric') {
            for (const expr of ['x', 'y', 'z'] as const) {
                if (!isString(source[expr]) || (source[expr] as string).length === 0) {
                    issue(ctx, `${path}.source.${expr}`, 'parametric expression must be a non-empty string');
                }
            }
            if (!isFiniteNumber(source.tStart)) {
                issue(ctx, `${path}.source.tStart`, 'tStart must be a finite number');
            }
            if (!isFiniteNumber(source.tEnd)) {
                issue(ctx, `${path}.source.tEnd`, 'tEnd must be a finite number');
            }
            if (isFiniteNumber(source.tStart) && isFiniteNumber(source.tEnd) && (source.tEnd as number) <= (source.tStart as number)) {
                issue(ctx, `${path}.source.tEnd`, 'tEnd must be greater than tStart');
            }
            const count = source.sampleCount;
            if (!Number.isInteger(count) || (count as number) < 8 || (count as number) > 4096) {
                issue(ctx, `${path}.source.sampleCount`, 'sampleCount must be an integer in [8, 4096]');
            }
        }
        if (kind === 'fourier') {
            const nfp = source.nfp;
            if (!Number.isInteger(nfp) || (nfp as number) < 1) {
                issue(ctx, `${path}.source.nfp`, 'nfp must be a positive integer');
            }
            const order = source.order;
            if (!Number.isInteger(order) || (order as number) < 0) {
                issue(ctx, `${path}.source.order`, 'order must be a non-negative integer');
            }
            const expectedLength = Number.isInteger(order) ? (order as number) + 1 : undefined;
            validateNumberArray(ctx, `${path}.source.cosX`, source.cosX, expectedLength);
            validateNumberArray(ctx, `${path}.source.cosY`, source.cosY, expectedLength);
            validateNumberArray(ctx, `${path}.source.cosZ`, source.cosZ, expectedLength);
            // sin arrays may be shorter than order + 1; missing entries read as 0.
            for (const arr of ['sinX', 'sinY', 'sinZ'] as const) {
                if (source[arr] !== undefined) {
                    validateNumberArray(ctx, `${path}.source.${arr}`, source[arr], expectedLength, true);
                }
            }
            const count = source.sampleCount;
            if (!Number.isInteger(count) || (count as number) < 32 || (count as number) > 4096) {
                issue(ctx, `${path}.source.sampleCount`, 'sampleCount must be an integer in [32, 4096]');
            }
        }
    }
    if (!Array.isArray(curve.samples)) {
        issue(ctx, `${path}.samples`, 'samples must be an array of curve points');
    } else {
        if (curve.samples.length < 4) {
            issue(ctx, `${path}.samples`, 'curve must have at least 4 samples');
        }
        for (const [i, point] of curve.samples.entries()) {
            validateCurvePoint(ctx, `${path}.samples[${i}]`, point);
        }
    }
}

/**
 * Validate a `.nuke-cad` document.
 *
 * Returns a structured list of issues covering duplicate ids, dangling
 * references, parameter name collisions, and out-of-range feature parameters.
 */
export function validateNukeCadDocument(doc: NukeCadDocument): ValidationResult {
    const ctx: MutableValidationContext = { issues: [], ids: new Set<string>() };

    if (!isPlainObject(doc)) {
        return { valid: false, issues: [{ path: '', message: 'document must be an object' }] };
    }
    if (doc.version !== NUKE_CAD_SCHEMA_VERSION) {
        issue(ctx, 'version', `expected version ${NUKE_CAD_SCHEMA_VERSION}, got ${doc.version}`);
    }
    if (!isString(doc.name)) {
        issue(ctx, 'name', 'name must be a string');
    }
    if (!isPlainObject(doc.parameters)) {
        issue(ctx, 'parameters', 'parameters must be an object');
    } else {
        for (const [name, value] of Object.entries(doc.parameters)) {
            if (!isFiniteNumber(value)) {
                issue(ctx, `parameters.${name}`, 'parameter value must be finite');
            }
        }
    }
    if (!Array.isArray(doc.datums)) {
        issue(ctx, 'datums', 'datums must be an array');
    } else {
        for (const [i, datum] of doc.datums.entries()) {
            validateDatum(ctx, datum as DatumPlane, i);
        }
    }
    if (!Array.isArray(doc.bodies)) {
        issue(ctx, 'bodies', 'bodies must be an array');
    } else {
        for (const [i, body] of doc.bodies.entries()) {
            validateBody(ctx, body as BodyDef, i);
        }
    }
    const documentParamNames = new Set<string>(Object.keys(doc.parameters ?? {}));
    if (!Array.isArray(doc.sketches)) {
        issue(ctx, 'sketches', 'sketches must be an array');
    } else {
        for (const [i, sketch] of doc.sketches.entries()) {
            validateSketch(ctx, sketch as SketchDef, i);
            const s = sketch as SketchDef;
            if (s.parameters) {
                for (const name of Object.keys(s.parameters)) {
                    if (documentParamNames.has(name)) {
                        issue(ctx, `sketches[${i}].parameters.${name}`, `parameter name '${name}' collides with a document parameter`);
                    }
                }
            }
        }
    }
    if (!Array.isArray(doc.features)) {
        issue(ctx, 'features', 'features must be an array');
    } else {
        for (const [i, feature] of doc.features.entries()) {
            validateFeature(ctx, feature as FeatureDef, i);
        }
    }
    if (!Array.isArray(doc.curves)) {
        issue(ctx, 'curves', 'curves must be an array');
    } else {
        for (const [i, curve] of doc.curves.entries()) {
            validateCurve(ctx, curve as CurveDef, i);
        }
    }

    // Dangling reference pass.
    const datumIds = new Set<string>(doc.datums?.map((d) => (d as DatumPlane).id).filter(isString) ?? []);
    const bodyIds = new Set<string>(doc.bodies?.map((b) => (b as BodyDef).id).filter(isString) ?? []);
    const sketchIds = new Set<string>(doc.sketches?.map((s) => (s as SketchDef).id).filter(isString) ?? []);
    const featureIds = new Set<string>(doc.features?.map((f) => (f as FeatureDef).id).filter(isString) ?? []);
    const curveIds = new Set<string>((Array.isArray(doc.curves) ? doc.curves : []).map((c) => (c as CurveDef).id).filter(isString));

    for (const [i, sketch] of (doc.sketches ?? []).entries()) {
        const s = sketch as SketchDef;
        if (s.datumId && !datumIds.has(s.datumId)) {
            issue(ctx, `sketches[${i}].datumId`, `unknown datum '${s.datumId}'`);
        }
    }
    for (const [i, feature] of (doc.features ?? []).entries()) {
        const f = feature as FeatureDef;
        if (f.body && !bodyIds.has(f.body)) {
            issue(ctx, `features[${i}].body`, `unknown body '${f.body}'`);
        }
        if (f.sketchId && !sketchIds.has(f.sketchId)) {
            issue(ctx, `features[${i}].sketchId`, `unknown sketch '${f.sketchId}'`);
        }
        for (const [j, dep] of (f.dependsOn ?? []).entries()) {
            if (isString(dep) && !featureIds.has(dep)) {
                issue(ctx, `features[${i}].dependsOn[${j}]`, `unknown feature '${dep}'`);
            }
        }
        if (f.type === 'booleanFuse' || f.type === 'booleanCut' || f.type === 'booleanCommon') {
            const p = f.params as Record<string, unknown>;
            if (isString(p.targetBody) && !bodyIds.has(p.targetBody)) {
                issue(ctx, `features[${i}].params.targetBody`, `unknown body '${p.targetBody}'`);
            }
            if (Array.isArray(p.toolBodies)) {
                for (const [j, tool] of p.toolBodies.entries()) {
                    if (isString(tool) && !bodyIds.has(tool)) {
                        issue(ctx, `features[${i}].params.toolBodies[${j}]`, `unknown body '${tool}'`);
                    }
                }
            }
        }
        if (f.type === 'linearPattern' || f.type === 'circularPattern' || f.type === 'mirror') {
            const p = f.params as Record<string, unknown>;
            if (isString(p.source) && !featureIds.has(p.source)) {
                issue(ctx, `features[${i}].params.source`, `unknown feature '${p.source}'`);
            }
        }
        if (f.type === 'circularPattern') {
            const p = f.params as Record<string, unknown>;
            if (isString(p.axisDatumId) && !datumIds.has(p.axisDatumId)) {
                issue(ctx, `features[${i}].params.axisDatumId`, `unknown datum '${p.axisDatumId}'`);
            }
        }
        if (f.type === 'mirror') {
            const p = f.params as Record<string, unknown>;
            if (isString(p.planeDatumId) && !datumIds.has(p.planeDatumId)) {
                issue(ctx, `features[${i}].params.planeDatumId`, `unknown datum '${p.planeDatumId}'`);
            }
        }
        if (f.type === 'sweep' || f.type === 'pipe') {
            const p = f.params as Record<string, unknown>;
            if (isString(p.pathCurveId) && p.pathCurveId.length > 0 && !curveIds.has(p.pathCurveId)) {
                issue(ctx, `features[${i}].params.pathCurveId`, `unknown curve '${p.pathCurveId}'`);
            }
        }
        if (f.type === 'loft') {
            const p = f.params as Record<string, unknown>;
            if (Array.isArray(p.sectionSketchIds)) {
                for (const [j, sid] of p.sectionSketchIds.entries()) {
                    if (isString(sid) && sid.length > 0 && !sketchIds.has(sid)) {
                        issue(ctx, `features[${i}].params.sectionSketchIds[${j}]`, `unknown sketch '${sid}'`);
                    }
                }
            }
        }
        if (f.type === 'hole') {
            const p = f.params as Record<string, unknown>;
            if (isPlainObject(p.face)) {
                validateEmbeddedTopologyRef(ctx, `features[${i}].params.face`, p.face);
            }
        }
    }

    return { valid: ctx.issues.length === 0, issues: ctx.issues };
}

/** Result of {@link migrateNukeCadDocument}. */
export interface NukeCadMigrationResult {
    /** Migrated document. */
    document: NukeCadDocument;
    /** Original version when a migration ran. */
    migratedFrom?: number;
}

function migrateV1ToV2(doc: NukeCadDocument): NukeCadDocument {
    /**
     * Migration strategy:
     *
     * - Every pad/revolve creates its own body: id `body-<featureId>`, name from
     *   the feature name, label from the feature label. Because same-body
     *   additive append is non-fusing, splitting v1's single accumulator into
     *   per-feature bodies produces the identical final compound.
     * - Every pocket/groove targets the body of its first `dependsOn` entry's
     *   body; with no `dependsOn`, the body of the nearest preceding pad/revolve
     *   in document order. v1 pockets cut the entire accumulated compound, so
     *   documents relying on cross-region cuts change semantics.
     * - `dependsOn` is preserved verbatim; feature `label` fields are dropped.
     */
    const features = (doc.features ?? []).map((f) => ({ ...(f as FeatureDef) }));
    const bodies: BodyDef[] = [];
    const bodyIdForFeature = new Map<string, string>();

    const solidCreators: FeatureType[] = ['pad', 'revolve'];
    const solidModifiers: FeatureType[] = ['pocket', 'groove'];

    for (const feature of features) {
        if (!solidCreators.includes(feature.type)) {
            continue;
        }
        const bodyId = `body-${feature.id}`;
        const label = (feature as unknown as Record<string, unknown>).label;
        bodies.push({
            id: bodyId,
            name: feature.name,
            label: typeof label === 'string' && label.length > 0 ? label : undefined
        });
        bodyIdForFeature.set(feature.id, bodyId);
        delete (feature as unknown as Record<string, unknown>).label;
    }

    for (const feature of features) {
        if (!solidModifiers.includes(feature.type)) {
            continue;
        }
        let bodyId: string | undefined;
        for (const dep of feature.dependsOn ?? []) {
            if (bodyIdForFeature.has(dep)) {
                bodyId = bodyIdForFeature.get(dep);
                break;
            }
        }
        if (bodyId === undefined) {
            // Nearest preceding pad/revolve in document order.
            const index = features.findIndex((f) => f.id === feature.id);
            for (let i = index - 1; i >= 0; i--) {
                const preceding = features[i];
                if (solidCreators.includes(preceding.type) && bodyIdForFeature.has(preceding.id)) {
                    bodyId = bodyIdForFeature.get(preceding.id);
                    break;
                }
            }
        }
        feature.body = bodyId ?? 'body-default';
        delete (feature as unknown as Record<string, unknown>).label;
    }

    for (const feature of features) {
        if (solidCreators.includes(feature.type)) {
            feature.body = bodyIdForFeature.get(feature.id)!;
        }
    }

    // Any remaining feature without a body gets a default body so validation
    // does not fail on otherwise well-formed legacy documents.
    for (const feature of features) {
        if (!feature.body) {
            feature.body = 'body-default';
        }
    }
    if (features.some((f) => f.body === 'body-default') && !bodies.some((b) => b.id === 'body-default')) {
        bodies.push({ id: 'body-default', name: 'Default Body' });
    }

    return {
        version: 2,
        name: typeof doc.name === 'string' ? doc.name : 'migrated',
        parameters: isPlainObject(doc.parameters) ? (doc.parameters as Record<string, number>) : {},
        datums: Array.isArray(doc.datums) ? (doc.datums as DatumPlane[]) : [],
        bodies,
        sketches: Array.isArray(doc.sketches) ? (doc.sketches as SketchDef[]) : [],
        features,
        curves: []
    };
}

function migrateV2ToV3(doc: NukeCadDocument): NukeCadDocument {
    return {
        ...doc,
        version: 3,
        curves: []
    };
}

/**
 * Migrate a parsed `.nuke-cad` document to the current schema version.
 *
 * Registers migration steps in {@link MIGRATIONS} keyed by the version they
 * upgrade from. Version 1 documents are migrated to version 2 by creating one
 * body per additive feature and assigning subtractive features to the
 * appropriate body. Version 2 documents are migrated to version 3 by adding an
 * empty ``curves`` array.
 */
export function migrateNukeCadDocument(json: unknown): NukeCadMigrationResult {
    if (!isPlainObject(json)) {
        throw new Error('.nuke-cad document must be an object');
    }
    const version = json.version;
    if (typeof version !== 'number' || !Number.isInteger(version)) {
        throw new Error(`.nuke-cad document version must be an integer, got ${version}`);
    }
    if (version === NUKE_CAD_SCHEMA_VERSION) {
        return { document: json as unknown as NukeCadDocument };
    }
    if (version > NUKE_CAD_SCHEMA_VERSION) {
        throw new Error(`Unsupported .nuke-cad schema version ${version} (this build supports up to ${NUKE_CAD_SCHEMA_VERSION})`);
    }
    const steps: Record<number, (doc: NukeCadDocument) => NukeCadDocument> = {
        1: migrateV1ToV2,
        2: migrateV2ToV3
    };
    let current = json as unknown as NukeCadDocument;
    let guard = 0;
    while (current.version !== NUKE_CAD_SCHEMA_VERSION) {
        const step = steps[current.version];
        if (!step) {
            throw new Error(
                `Unsupported .nuke-cad schema version ${current.version} (this build supports up to ${NUKE_CAD_SCHEMA_VERSION})`
            );
        }
        current = step(current);
        if (++guard > 20) {
            throw new Error('.nuke-cad schema migration did not converge');
        }
    }
    return { document: current, migratedFrom: version };
}
