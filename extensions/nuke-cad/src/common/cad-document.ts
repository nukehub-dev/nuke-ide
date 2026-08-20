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
 * Version 1 models the base document: parameters, datum planes, sketches
 * (planegcs-verbatim primitives and constraints), and a feature tree.
 *
 * @module nuke-cad/common
 */

import { validateTopologyRef, type TopologyRef } from './topology-refs';

/** Current `.nuke-cad` schema version. */
export const NUKE_CAD_SCHEMA_VERSION = 1;

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
}

/** Feature types for solid features. */
export type FeatureType =
    | 'pad'
    | 'pocket'
    | 'revolve'
    | 'groove'
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

/** Parameters for fillet/chamfer. */
export interface FilletParams {
    edges: TopologyRef[];
    radius?: number;
    distances?: [number, number];
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

/** Parameters for patterns. */
export interface PatternParams {
    count: number;
    spacing?: number;
    angle?: number;
    axis?: 'x' | 'y' | 'z';
}

/** Parameters for booleans. */
export interface BooleanParams {
    targetBody: string;
}

/** Parameters for holes. */
export interface HoleParams {
    diameter: number;
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
    | FilletParams
    | ShellParams
    | DraftParams
    | PatternParams
    | BooleanParams
    | HoleParams
    | Record<string, unknown>;

/** A parametric feature in the model tree. */
export interface FeatureDef {
    id: string;
    name: string;
    type: FeatureType;
    /** Sketch consumed by the feature (implied dependency). */
    sketchId?: string;
    /** Feature-specific parameters. */
    params: FeatureParams;
    /** When true the feature is excluded from the build. */
    suppressed: boolean;
    /** Per-feature volume label written to the region manifest. */
    label?: string;
    /** Explicit upstream feature dependencies (in addition to sketchId). */
    dependsOn: string[];
}

/** Complete `.nuke-cad` document. */
export interface NukeCadDocument {
    version: number;
    name: string;
    parameters: Record<string, number>;
    datums: DatumPlane[];
    sketches: SketchDef[];
    features: FeatureDef[];
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

function validateSketch(ctx: MutableValidationContext, sketch: SketchDef, index: number): void {
    const path = `sketches[${index}]`;
    requireId(ctx, `${path}.id`, sketch.id);
    if (!isString(sketch.name)) {
        issue(ctx, `${path}.name`, 'name must be a string');
    }
    if (!isString(sketch.datumId)) {
        issue(ctx, `${path}.datumId`, 'datumId must be a string');
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
        case 'fillet':
        case 'chamfer':
            if (!Array.isArray(p.edges) || p.edges.length === 0) {
                issue(ctx, `${path}.edges`, 'edges must be a non-empty array of TopologyRefs');
            } else {
                for (const [i, edge] of p.edges.entries()) {
                    validateEmbeddedTopologyRef(ctx, `${path}.edges[${i}]`, edge);
                }
            }
            if (p.radius !== undefined && (!isFiniteNumber(p.radius) || p.radius <= 0)) {
                issue(ctx, `${path}.radius`, 'radius must be a positive finite number');
            }
            break;
        case 'shell':
            if (!Array.isArray(p.faces) || p.faces.length === 0) {
                issue(ctx, `${path}.faces`, 'faces must be a non-empty array of TopologyRefs');
            } else {
                for (const [i, face] of p.faces.entries()) {
                    validateEmbeddedTopologyRef(ctx, `${path}.faces[${i}]`, face);
                }
            }
            if (p.thickness !== undefined && (!isFiniteNumber(p.thickness) || p.thickness <= 0)) {
                issue(ctx, `${path}.thickness`, 'thickness must be a positive finite number');
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
            if (p.angle !== undefined && (!isFiniteNumber(p.angle) || p.angle <= -90 || p.angle >= 90)) {
                issue(ctx, `${path}.angle`, 'draft angle must be between -90 and 90 degrees');
            }
            break;
        case 'linearPattern':
        case 'circularPattern': {
            const count = p.count;
            if (count === undefined || typeof count !== 'number' || !Number.isInteger(count) || count < 1) {
                issue(ctx, `${path}.count`, 'count is required and must be a positive integer');
            }
            break;
        }
        case 'hole':
            if (!isFiniteNumber(p.diameter) || p.diameter <= 0) {
                issue(ctx, `${path}.diameter`, 'diameter is required and must be a positive finite number');
            }
            break;
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

    // Dangling reference pass.
    const datumIds = new Set<string>(doc.datums?.map((d) => (d as DatumPlane).id).filter(isString) ?? []);
    const sketchIds = new Set<string>(doc.sketches?.map((s) => (s as SketchDef).id).filter(isString) ?? []);
    const featureIds = new Set<string>(doc.features?.map((f) => (f as FeatureDef).id).filter(isString) ?? []);

    for (const [i, sketch] of (doc.sketches ?? []).entries()) {
        const s = sketch as SketchDef;
        if (s.datumId && !datumIds.has(s.datumId)) {
            issue(ctx, `sketches[${i}].datumId`, `unknown datum '${s.datumId}'`);
        }
    }
    for (const [i, feature] of (doc.features ?? []).entries()) {
        const f = feature as FeatureDef;
        if (f.sketchId && !sketchIds.has(f.sketchId)) {
            issue(ctx, `features[${i}].sketchId`, `unknown sketch '${f.sketchId}'`);
        }
        for (const [j, dep] of (f.dependsOn ?? []).entries()) {
            if (isString(dep) && !featureIds.has(dep)) {
                issue(ctx, `features[${i}].dependsOn[${j}]`, `unknown feature '${dep}'`);
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

/**
 * Migrate a parsed `.nuke-cad` document to the current schema version.
 *
 * Currently only version 1 is accepted. Future migrations register steps in
 * {@link MIGRATIONS} keyed by the version they upgrade from.
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
    const steps: Record<number, (doc: NukeCadDocument) => NukeCadDocument> = {};
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
