// *****************************************************************************
// Copyright (C) 2026 NukeHub and others.
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
 * Pure planner for the self-contained W7-X native coil shape study.
 *
 * The exact W7-X generator imports the pinned reference STEP and the 4/6-module
 * study reuses those imported bodies. This planner takes the other path: ten
 * committed reference centerlines become ten native `coilSweep` features, and
 * the ten editable bodies are placed across the five physically valid modules
 * (50 instances) with pure Z rotations. No STEP is read or bundled.
 *
 * The native sweeps are a design study, not a replacement for the reference
 * B-rep: the document carries a `w7x-coil-shape-study` design marker so the
 * backend keeps serving display builds while rejecting DAGMC/FEM export.
 *
 * @module nuke-cad/common
 */

import w7xCoilsJson from './samples/w7x/w7x_coils.json';
import { NUKE_CAD_SCHEMA_VERSION } from './cad-document';
import type {
    BodyDef,
    CoilSweepParams,
    CurveDef,
    CurvePoint,
    DatumPlane,
    DocumentUnits,
    FeatureDef,
    ImportSourceUnit,
    NukeCadDocument,
    W7xCoilShapeStudy,
    W7xCoilShapeStudyReport
} from './cad-document';
import type { PosQuatPlacement } from './assembly-document';
import { W7X_GEOMETRY_ASSET, W7X_MODULE_COUNT, W7X_MODULE_ROTATIONS_DEG, quaternionForZRotation } from './w7x-generator';

/** Editable parameters shared by all ten native coil sweeps. */
export interface W7xShapeStudyConfig {
    /** Rectangular section width in metres; positive finite. */
    readonly width: number;
    /** Rectangular section height in metres; positive finite. */
    readonly height: number;
    /** Constant section tilt from the tangent-normal plane, degrees in [-89, 89]. */
    readonly tiltDeg: number;
    /** Total twist around the path, degrees; finite. */
    readonly twistDeg: number;
    /** Loft stations along each centerline; integer in [8, 720]. */
    readonly stations: number;
}

/** Default section/tilt/twist/station values for the native shape study. */
export const W7X_SHAPE_DEFAULTS: W7xShapeStudyConfig = {
    width: 0.37,
    height: 0.37,
    tiltDeg: 8.6,
    twistDeg: 0,
    stations: 60
};

/** Default document name used when only a config is supplied. */
export const W7X_SHAPE_DEFAULT_NAME = 'W7-X coil shape study';
/** Stable curve-id prefix; the two-digit shape number is appended. */
export const W7X_SHAPE_CURVE_PREFIX = 'curve-coil-';
/** Stable body-id prefix; the two-digit shape number is appended. */
export const W7X_SHAPE_BODY_PREFIX = 'body-coil-';
/** Stable feature-id prefix; the two-digit shape number is appended. */
export const W7X_SHAPE_FEATURE_PREFIX = 'coil-sweep-';
/** Number of distinct native coil bodies. */
export const W7X_SHAPE_BODY_COUNT = 10;
/** Coil instances in the locked five-module layout (10 shapes × 5 modules). */
export const W7X_SHAPE_INSTANCE_COUNT = 50;
/** The one grounded instance (module-0 copy of the first coil). */
export const W7X_SHAPE_GROUNDED_INSTANCE_ID = 'coil_01_m0';
/** Required sample count per committed centerline (first point repeated at the end). */
export const W7X_SHAPE_SAMPLE_COUNT = 121;
/** Minimum accepted loft stations. */
export const W7X_SHAPE_MIN_STATIONS = 8;
/** Maximum accepted loft stations. */
export const W7X_SHAPE_MAX_STATIONS = 720;
/** Minimum accepted constant section tilt. */
export const W7X_SHAPE_MIN_TILT_DEG = -89;
/** Maximum accepted constant section tilt. */
export const W7X_SHAPE_MAX_TILT_DEG = 89;
/**
 * Expected reference coil volume for one five-module module, in m³.
 *
 * The shape-study report states this per-module total explicitly; the full
 * fifty-coil assembly is five times this value (~138.042528 m³).
 */
export const W7X_SHAPE_REFERENCE_VOLUME_M3 = 27.608505577;

/** One module transform recorded on a committed coil shape. */
export interface W7xCoilShapeTransform {
    /** 1-based explorer-order index in the reference STEP. */
    readonly index: number;
    /** Pure Z rotation from the module-0 representative, in degrees. */
    readonly rotationDeg: number;
}

/** Axis-aligned reference bounding box of one coil shape. */
export interface W7xCoilShapeBbox {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
    readonly dims: readonly [number, number, number];
}

/** One distinct reference coil shape with its extracted centerline samples. */
export interface W7xCoilShapeEntry {
    /** Stable body label (`coil_01` … `coil_10`). */
    readonly id: string;
    /** 1-based explorer-order index of the module-0 representative solid. */
    readonly representativeIndex: number;
    /** Reference solid volume in m³. */
    readonly referenceVolumeM3: number;
    /** Reference solid surface area in m². */
    readonly referenceAreaM2: number;
    /** Reference solid bounding box in metres. */
    readonly referenceBbox: W7xCoilShapeBbox;
    /** Reference solid centroid in metres. */
    readonly referenceCenterM3: readonly [number, number, number];
    /** Closed centerline samples: 121 points with the first point repeated last. */
    readonly samples: readonly CurvePoint[];
    /** Five module copies in module order. */
    readonly transforms: readonly W7xCoilShapeTransform[];
}

/** Committed provenance for the centerline asset. */
export interface W7xCoilShapeSource {
    readonly fileName: string;
    readonly license: string;
    /** Lowercase SHA-256 hex of the reference STEP bytes. */
    readonly sourceHash: string;
    /** Reference STEP byte size. */
    readonly sourceSize: number;
    readonly sourceUnit: ImportSourceUnit;
    readonly documentUnits: DocumentUnits;
}

/** The small committed W7-X coil-centerline asset (never the 47 MB STEP). */
export interface W7xCoilShapeAsset {
    readonly source: W7xCoilShapeSource;
    readonly moduleCount: number;
    readonly moduleAngleDeg: number;
    readonly coilShapeCount: number;
    readonly coilShapes: readonly W7xCoilShapeEntry[];
}

/** Bundled reference centerlines; the shape study is locked to this asset. */
export const W7X_COIL_SHAPE_ASSET = w7xCoilsJson as unknown as W7xCoilShapeAsset;

/** One placed shape-study instance, expressed with the frozen assembly placement type. */
export interface W7xShapeStudyInstanceDraft {
    /** Stable instance id (`coil_01_m0` … `coil_10_m4`). */
    readonly id: string;
    /** `body:<body id>` reference understood by the assembly builder. */
    readonly part: string;
    readonly placement: PosQuatPlacement;
}

/** Complete deterministic plan for one self-contained native coil shape study. */
export interface W7xShapeStudyPlan {
    readonly document: NukeCadDocument;
    readonly curves: CurveDef[];
    readonly bodies: BodyDef[];
    readonly features: FeatureDef[];
    readonly instances: W7xShapeStudyInstanceDraft[];
    readonly designStudy: W7xCoilShapeStudy;
    /** Reference coil volume for one five-module module, in m³. */
    readonly referenceVolumeM3: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Runtime object guard that does not narrow an already-typed shape to a plain record. */
function isObject(value: unknown): boolean {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isFinitePoint3(value: unknown): value is readonly [number, number, number] {
    return Array.isArray(value) && value.length === 3 && value.every(isFiniteNumber);
}

function formatValue(value: unknown): string {
    if (typeof value === 'string') {
        return `'${value}'`;
    }
    if (typeof value === 'number' || typeof value === 'boolean' || value === undefined || value === null) {
        return String(value);
    }
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function assetError(message: string): never {
    throw new Error(`W7-X coil shape study asset is invalid: ${message}`);
}

function requirePoint3(value: unknown, path: string): readonly [number, number, number] {
    if (!isFinitePoint3(value)) {
        assetError(`${path} must be a [x, y, z] tuple of finite numbers`);
    }
    return value;
}

function pointsEqual(a: readonly [number, number, number], b: readonly [number, number, number]): boolean {
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function paddedShapeId(prefix: string, index: number): string {
    return `${prefix}${String(index).padStart(2, '0')}`;
}

/**
 * Validate the committed centerline asset against the pinned W7-X inventory.
 *
 * Checks the reference source hash/size (shared with `w7x_geometry.json`),
 * module geometry, ten sequential shapes, unique ids and indices, 121 finite
 * closed samples per shape, five pure-Z 72° transforms at the expected source
 * indices, finite positive reference metrics, and the expected one-module
 * reference volume. Throws a path-qualified error on the first problem.
 */
export function validateW7xCoilShapeAsset(asset: W7xCoilShapeAsset = W7X_COIL_SHAPE_ASSET): W7xCoilShapeAsset {
    if (!isPlainObject(asset)) {
        assetError('expected an object');
    }
    if (!isPlainObject(asset.source)) {
        assetError('source must be an object');
    }

    const source = asset.source as unknown as Record<string, unknown>;
    const expectedSource = W7X_GEOMETRY_ASSET.source;
    if (source.fileName !== expectedSource.fileName) {
        assetError(`source.fileName must be '${expectedSource.fileName}', got ${formatValue(source.fileName)}`);
    }
    if (source.license !== expectedSource.license) {
        assetError(`source.license must be '${expectedSource.license}', got ${formatValue(source.license)}`);
    }
    if (source.sourceHash !== expectedSource.sourceHash) {
        assetError(`source.sourceHash must match w7x_geometry.json (${expectedSource.sourceHash}), got ${formatValue(source.sourceHash)}`);
    }
    if (source.sourceSize !== expectedSource.sourceSize) {
        assetError(`source.sourceSize must match w7x_geometry.json (${expectedSource.sourceSize}), got ${formatValue(source.sourceSize)}`);
    }
    if (source.sourceUnit !== expectedSource.sourceUnit) {
        assetError(`source.sourceUnit must be '${expectedSource.sourceUnit}', got ${formatValue(source.sourceUnit)}`);
    }
    if (source.documentUnits !== expectedSource.documentUnits) {
        assetError(`source.documentUnits must be '${expectedSource.documentUnits}', got ${formatValue(source.documentUnits)}`);
    }

    if (asset.moduleCount !== W7X_MODULE_COUNT) {
        assetError(`moduleCount must be ${W7X_MODULE_COUNT}, got ${formatValue(asset.moduleCount)}`);
    }
    if (asset.moduleAngleDeg !== 72) {
        assetError(`moduleAngleDeg must be 72, got ${formatValue(asset.moduleAngleDeg)}`);
    }
    if (asset.coilShapeCount !== W7X_SHAPE_BODY_COUNT) {
        assetError(`coilShapeCount must be ${W7X_SHAPE_BODY_COUNT}, got ${formatValue(asset.coilShapeCount)}`);
    }
    if (!Array.isArray(asset.coilShapes) || asset.coilShapes.length !== W7X_SHAPE_BODY_COUNT) {
        assetError(`coilShapes must contain exactly ${W7X_SHAPE_BODY_COUNT} shapes, got ${formatValue(asset.coilShapes?.length)}`);
    }

    const ids = new Set<string>();
    const representativeIndices = new Set<number>();
    const transformIndices = new Set<number>();
    let referenceVolumeM3 = 0;

    for (const [index, shape] of asset.coilShapes.entries()) {
        const shapeNumber = index + 1;
        if (!isObject(shape)) {
            assetError(`coilShapes[${index}] must be an object`);
        }

        const expectedId = paddedShapeId('coil_', shapeNumber);
        if (typeof shape.id !== 'string' || shape.id.length === 0) {
            assetError(`coilShapes[${index}].id must be a non-empty string`);
        }
        if (shape.id !== expectedId) {
            assetError(`coilShapes[${index}].id must be '${expectedId}', got ${formatValue(shape.id)}`);
        }
        if (ids.has(shape.id)) {
            assetError(`coilShapes[${index}].id '${shape.id}' is duplicated`);
        }
        ids.add(shape.id);

        if (
            !Number.isInteger(shape.representativeIndex) ||
            shape.representativeIndex < 1 ||
            shape.representativeIndex > W7X_SHAPE_BODY_COUNT
        ) {
            assetError(
                `coilShapes[${index}].representativeIndex must be an integer in [1, ${W7X_SHAPE_BODY_COUNT}], got ${formatValue(shape.representativeIndex)}`
            );
        }
        if (shape.representativeIndex !== shapeNumber) {
            assetError(`coilShapes[${index}].representativeIndex must be ${shapeNumber}, got ${shape.representativeIndex}`);
        }
        if (representativeIndices.has(shape.representativeIndex)) {
            assetError(`coilShapes[${index}].representativeIndex ${shape.representativeIndex} is duplicated`);
        }
        representativeIndices.add(shape.representativeIndex);

        if (!isFiniteNumber(shape.referenceVolumeM3) || shape.referenceVolumeM3 <= 0) {
            assetError(
                `coilShapes[${index}].referenceVolumeM3 must be a positive finite number, got ${formatValue(shape.referenceVolumeM3)}`
            );
        }
        if (!isFiniteNumber(shape.referenceAreaM2) || shape.referenceAreaM2 <= 0) {
            assetError(`coilShapes[${index}].referenceAreaM2 must be a positive finite number, got ${formatValue(shape.referenceAreaM2)}`);
        }
        requirePoint3(shape.referenceCenterM3, `coilShapes[${index}].referenceCenterM3`);

        if (!isPlainObject(shape.referenceBbox)) {
            assetError(`coilShapes[${index}].referenceBbox must be an object`);
        }
        const bbox = shape.referenceBbox as unknown as Record<string, unknown>;
        for (const key of ['min', 'max', 'dims'] as const) {
            requirePoint3(bbox[key], `coilShapes[${index}].referenceBbox.${key}`);
        }
        const dims = bbox.dims as readonly [number, number, number];
        if (dims.some((value) => value <= 0)) {
            assetError(`coilShapes[${index}].referenceBbox.dims must be positive`);
        }

        if (!Array.isArray(shape.samples) || shape.samples.length !== W7X_SHAPE_SAMPLE_COUNT) {
            assetError(
                `coilShapes[${index}].samples must contain exactly ${W7X_SHAPE_SAMPLE_COUNT} points, got ${formatValue(shape.samples?.length)}`
            );
        }
        for (const [sampleIndex, sample] of shape.samples.entries()) {
            requirePoint3(sample, `coilShapes[${index}].samples[${sampleIndex}]`);
        }
        if (!pointsEqual(shape.samples[0], shape.samples[shape.samples.length - 1])) {
            assetError(`coilShapes[${index}].samples must be a closed centerline (first and last samples must match)`);
        }

        if (!Array.isArray(shape.transforms) || shape.transforms.length !== W7X_MODULE_ROTATIONS_DEG.length) {
            assetError(
                `coilShapes[${index}].transforms must contain exactly ${W7X_MODULE_ROTATIONS_DEG.length} module transforms, got ${formatValue(
                    shape.transforms?.length
                )}`
            );
        }
        for (const [moduleIndex, transform] of shape.transforms.entries()) {
            if (!isObject(transform)) {
                assetError(`coilShapes[${index}].transforms[${moduleIndex}] must be an object`);
            }
            const expectedRotationDeg = W7X_MODULE_ROTATIONS_DEG[moduleIndex];
            if (transform.rotationDeg !== expectedRotationDeg) {
                assetError(
                    `coilShapes[${index}].transforms[${moduleIndex}].rotationDeg must be ${expectedRotationDeg}, got ${formatValue(
                        transform.rotationDeg
                    )}`
                );
            }
            const expectedIndex = shape.representativeIndex + 10 * moduleIndex;
            if (transform.index !== expectedIndex) {
                assetError(
                    `coilShapes[${index}].transforms[${moduleIndex}].index must be ${expectedIndex}, got ${formatValue(transform.index)}`
                );
            }
            if (transformIndices.has(transform.index)) {
                assetError(`coilShapes[${index}].transforms[${moduleIndex}].index ${transform.index} is duplicated`);
            }
            transformIndices.add(transform.index);
        }

        referenceVolumeM3 += shape.referenceVolumeM3;
    }

    if (Math.abs(referenceVolumeM3 - W7X_SHAPE_REFERENCE_VOLUME_M3) > 1e-6) {
        assetError(`reference volume sum must be ${W7X_SHAPE_REFERENCE_VOLUME_M3} m^3 for one module, got ${referenceVolumeM3} m^3`);
    }

    return asset;
}

function requirePositiveConfigNumber(field: string, value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new Error(`W7-X coil shape study ${field} must be a positive finite number, got ${formatValue(value)}.`);
    }
    return value;
}

function requireFiniteConfigNumber(field: string, value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`W7-X coil shape study ${field} must be a finite number, got ${formatValue(value)}.`);
    }
    return value;
}

/**
 * Resolve partial overrides over {@link W7X_SHAPE_DEFAULTS}.
 *
 * A field uses its default only when it is absent (`undefined`). Every supplied
 * value is validated exactly (no silent clamping) and the resolved config is
 * returned as a fresh object.
 */
function resolveW7xShapeStudyConfig(config?: Partial<W7xShapeStudyConfig>): W7xShapeStudyConfig {
    if (config !== undefined && (!isPlainObject(config) || Array.isArray(config))) {
        throw new Error('W7-X coil shape study config must be an object when provided.');
    }
    const overrides: Partial<W7xShapeStudyConfig> = config ?? {};
    const width = requirePositiveConfigNumber('section width', overrides.width === undefined ? W7X_SHAPE_DEFAULTS.width : overrides.width);
    const height = requirePositiveConfigNumber(
        'section height',
        overrides.height === undefined ? W7X_SHAPE_DEFAULTS.height : overrides.height
    );
    const tiltDeg = requireFiniteConfigNumber(
        'section tilt',
        overrides.tiltDeg === undefined ? W7X_SHAPE_DEFAULTS.tiltDeg : overrides.tiltDeg
    );
    if (tiltDeg < W7X_SHAPE_MIN_TILT_DEG || tiltDeg > W7X_SHAPE_MAX_TILT_DEG) {
        throw new Error(
            `W7-X coil shape study section tilt must be in [${W7X_SHAPE_MIN_TILT_DEG}, ${W7X_SHAPE_MAX_TILT_DEG}] degrees, got ${formatValue(
                tiltDeg
            )}.`
        );
    }
    const twistDeg = requireFiniteConfigNumber(
        'twist',
        overrides.twistDeg === undefined ? W7X_SHAPE_DEFAULTS.twistDeg : overrides.twistDeg
    );
    const stations = overrides.stations === undefined ? W7X_SHAPE_DEFAULTS.stations : overrides.stations;
    if (
        typeof stations !== 'number' ||
        !Number.isInteger(stations) ||
        stations < W7X_SHAPE_MIN_STATIONS ||
        stations > W7X_SHAPE_MAX_STATIONS
    ) {
        throw new Error(
            `W7-X coil shape study stations must be an integer in [${W7X_SHAPE_MIN_STATIONS}, ${W7X_SHAPE_MAX_STATIONS}], got ${formatValue(
                stations
            )}.`
        );
    }
    return { width, height, tiltDeg, twistDeg, stations };
}

/**
 * Round the reference total to the nine-decimal precision carried by the
 * committed asset metrics, so the reported one-module value is exactly
 * {@link W7X_SHAPE_REFERENCE_VOLUME_M3} instead of a binary-float artifact.
 */
function referenceVolumeForShapes(shapes: readonly W7xCoilShapeEntry[]): number {
    const sum = shapes.reduce((total, shape) => total + shape.referenceVolumeM3, 0);
    return Math.round(sum * 1e9) / 1e9;
}

function shapeStudySummary(referenceVolumeM3: number): string {
    const assemblyVolumeM3 = Math.round(referenceVolumeM3 * 5 * 1e6) / 1e6;
    return (
        `W7-X coil shape study: ${W7X_SHAPE_BODY_COUNT} native coil sweep bodies x ${W7X_MODULE_COUNT} modules = ` +
        `${W7X_SHAPE_INSTANCE_COUNT} coil instances. Native sweeps approximate the reference B-reps, not the exact B-rep. ` +
        `Reference coil volume is ${referenceVolumeM3.toFixed(9)} m^3 for one module ` +
        `(~${assemblyVolumeM3.toFixed(6)} m^3 across all ${W7X_SHAPE_INSTANCE_COUNT} coils). Simulation export is disabled.`
    );
}

function defaultDatums(): DatumPlane[] {
    return [
        { id: 'datum-xy', kind: 'XY', name: 'XY Plane' },
        { id: 'datum-yz', kind: 'YZ', name: 'YZ Plane' },
        { id: 'datum-xz', kind: 'XZ', name: 'XZ Plane' }
    ];
}

/**
 * Build the deterministic ten-body / fifty-instance native coil shape study.
 *
 * Every coil shape becomes one `points` curve, one body, and one `coilSweep`
 * feature whose rectangular section uses the resolved config. The ten bodies
 * are placed at the validated five-module rotations (0/72/144/216/288° about
 * global Z, identity translation), with `coil_01_m0` grounded. The document is
 * marked `w7x-coil-shape-study` and reports the one-module reference volume.
 *
 * @throws when a config field is invalid or the committed asset fails integrity
 * validation; nothing is clamped or silently repaired.
 */
export function planW7xShapeStudy(
    config?: Partial<W7xShapeStudyConfig>,
    asset: W7xCoilShapeAsset = W7X_COIL_SHAPE_ASSET
): W7xShapeStudyPlan {
    const resolved = resolveW7xShapeStudyConfig(config);
    const validated = validateW7xCoilShapeAsset(asset);
    const referenceVolumeM3 = referenceVolumeForShapes(validated.coilShapes);

    const curves: CurveDef[] = [];
    const bodies: BodyDef[] = [];
    const features: FeatureDef[] = [];
    const instances: W7xShapeStudyInstanceDraft[] = [];

    for (const [index, shape] of validated.coilShapes.entries()) {
        const shapeNumber = index + 1;
        const curveId = paddedShapeId(W7X_SHAPE_CURVE_PREFIX, shapeNumber);
        const bodyId = paddedShapeId(W7X_SHAPE_BODY_PREFIX, shapeNumber);
        const featureId = paddedShapeId(W7X_SHAPE_FEATURE_PREFIX, shapeNumber);

        curves.push({
            id: curveId,
            name: `${shape.id} centerline`,
            source: { kind: 'points' },
            samples: shape.samples.map(([x, y, z]): CurvePoint => [x, y, z])
        });
        bodies.push({
            id: bodyId,
            name: shape.id,
            label: shape.id
        });

        const params: CoilSweepParams = {
            pathCurveId: curveId,
            width: resolved.width,
            height: resolved.height,
            tiltDeg: resolved.tiltDeg,
            twistDeg: resolved.twistDeg,
            stations: resolved.stations
        };
        features.push({
            id: featureId,
            name: `${shape.id} sweep`,
            type: 'coilSweep',
            body: bodyId,
            params,
            suppressed: false,
            dependsOn: []
        });

        for (const [moduleIndex, rotationDeg] of W7X_MODULE_ROTATIONS_DEG.entries()) {
            const placement: PosQuatPlacement = {
                position: [0, 0, 0],
                orientation: quaternionForZRotation(rotationDeg)
            };
            instances.push({
                id: `${shape.id}_m${moduleIndex}`,
                part: `body:${bodyId}`,
                placement
            });
        }
    }

    const report: W7xCoilShapeStudyReport = {
        moduleCount: W7X_MODULE_COUNT,
        coilCount: W7X_SHAPE_INSTANCE_COUNT,
        bodyCount: W7X_SHAPE_BODY_COUNT,
        sectionWidthM: resolved.width,
        sectionHeightM: resolved.height,
        sectionTiltDeg: resolved.tiltDeg,
        twistDeg: resolved.twistDeg,
        stations: resolved.stations,
        referenceVolumeM3,
        summary: shapeStudySummary(referenceVolumeM3)
    };
    const designStudy: W7xCoilShapeStudy = {
        kind: 'w7x-coil-shape-study',
        report
    };

    const document: NukeCadDocument = {
        version: NUKE_CAD_SCHEMA_VERSION,
        name: W7X_SHAPE_DEFAULT_NAME,
        units: 'm',
        displayTolerance: 0.1,
        overlapCheck: false,
        parameters: {
            moduleCount: W7X_MODULE_COUNT,
            coilCount: W7X_SHAPE_INSTANCE_COUNT,
            sectionWidthM: resolved.width,
            sectionHeightM: resolved.height,
            sectionTiltDeg: resolved.tiltDeg,
            twistDeg: resolved.twistDeg,
            stations: resolved.stations
        },
        datums: defaultDatums(),
        bodies,
        sketches: [],
        features,
        curves,
        assembly: {
            instances,
            connectors: [],
            mates: [],
            groundedInstanceId: W7X_SHAPE_GROUNDED_INSTANCE_ID
        },
        designStudy
    };

    return { document, curves, bodies, features, instances, designStudy, referenceVolumeM3 };
}

/**
 * Build a shape-study document with a caller-chosen name.
 *
 * The widget can use this after the destination picker; the plan is otherwise
 * identical to {@link planW7xShapeStudy}. Empty names are rejected instead of
 * producing an unnamed document.
 */
export function createW7xShapeStudyDocument(name: string, config?: Partial<W7xShapeStudyConfig>): NukeCadDocument {
    if (typeof name !== 'string' || name.trim().length === 0) {
        throw new Error('W7-X coil shape study name must be a non-empty string.');
    }
    return { ...planW7xShapeStudy(config).document, name };
}
