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
 * Topological reference types for the toponaming system.
 *
 * References are never raw indices. The TypeScript side owns the type
 * definitions and validation; fingerprint matching/scoring lives in the Python
 * backend (`reference_scoring.py`, `reference_resolver.py`) so it can use OCP.
 *
 * @module nuke-cad/common
 */

/** Surface types that OCP can extract from a face. */
export type SurfaceType =
    'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'revolution' | 'extrusion' | 'offset' | 'bspline' | 'bezier' | 'other';

/** Curve types that OCP can extract from an edge. */
export type CurveType = 'line' | 'circle' | 'ellipse' | 'parabola' | 'hyperbola' | 'bspline' | 'bezier' | 'other';

/** A 3D point as a tuple. */
export type Point3 = [number, number, number];

/** Axis used by cylinders, cones, tori and surfaces of revolution. */
export interface Axis {
    origin: Point3;
    direction: Point3;
}

/** Geometric fingerprint of a face for toponaming v1. */
export interface FaceFingerprint {
    surfaceType: SurfaceType;
    /** Face area in square model units. */
    area: number;
    /** Centroid of the face. */
    center: Point3;
    /** Plane normal (for planar faces). */
    normal?: Point3;
    /** Revolution/sweep axis (for cylinders, cones, tori, revolutions). */
    axis?: Axis;
    /** Radius for spheres, cylinders, tori, etc. */
    radius?: number;
    /** Second radius for tori. */
    minorRadius?: number;
}

/** Geometric fingerprint of an edge for toponaming v1. */
export interface EdgeFingerprint {
    curveType: CurveType;
    /** Edge length in model units. */
    length: number;
    /** Start vertex. */
    start: Point3;
    /** End vertex. */
    end: Point3;
    /** Circle/arc center (for circular edges). */
    center?: Point3;
}

/** A reference to a topological entity produced by a feature. */
export interface TopologyRef {
    /** Producing feature id. */
    featureId: string;
    /** Topological kind. */
    kind: 'face' | 'edge';
    /** Geometric fingerprint used for matching after rebuild. */
    fingerprint: FaceFingerprint | EdgeFingerprint;
}

/** Result of validating a topology reference. */
export interface TopologyValidationResult {
    valid: boolean;
    issues: string[];
}

const SURFACE_TYPES: SurfaceType[] = [
    'plane',
    'cylinder',
    'cone',
    'sphere',
    'torus',
    'revolution',
    'extrusion',
    'offset',
    'bspline',
    'bezier',
    'other'
];

const CURVE_TYPES: CurveType[] = ['line', 'circle', 'ellipse', 'parabola', 'hyperbola', 'bspline', 'bezier', 'other'];

function isNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isPoint3(value: unknown): value is Point3 {
    return Array.isArray(value) && value.length === 3 && value.every(isNumber);
}

function isNonZeroVector(value: unknown, path: string): string[] {
    const issues: string[] = [];
    if (!isPoint3(value)) {
        issues.push(`${path} must be a [x, y, z] tuple`);
        return issues;
    }
    const [x, y, z] = value;
    if (x === 0 && y === 0 && z === 0) {
        issues.push(`${path} must be a non-zero vector`);
    }
    return issues;
}

function validateAxis(axis: Axis | undefined, path: string): string[] {
    const issues: string[] = [];
    if (axis === undefined) {
        return issues;
    }
    if (!isPoint3(axis.origin)) {
        issues.push(`${path}.origin must be a [x, y, z] tuple`);
    }
    issues.push(...isNonZeroVector(axis.direction, `${path}.direction`));
    return issues;
}

/** Validate a face fingerprint shape. */
export function validateFaceFingerprint(fp: FaceFingerprint): TopologyValidationResult {
    const issues: string[] = [];
    if (!isString(fp.surfaceType)) {
        issues.push('surfaceType is required');
    } else if (!SURFACE_TYPES.includes(fp.surfaceType)) {
        issues.push(`surfaceType must be one of ${SURFACE_TYPES.join(', ')}`);
    }
    if (!isNumber(fp.area) || fp.area <= 0) {
        issues.push('area must be a positive finite number');
    }
    if (!isPoint3(fp.center)) {
        issues.push('center must be a [x, y, z] tuple');
    }
    if (fp.normal !== undefined) {
        issues.push(...isNonZeroVector(fp.normal, 'normal'));
    }
    issues.push(...validateAxis(fp.axis, 'axis'));
    if (fp.radius !== undefined && (!isNumber(fp.radius) || fp.radius < 0)) {
        issues.push('radius must be a non-negative finite number');
    }
    if (fp.minorRadius !== undefined && (!isNumber(fp.minorRadius) || fp.minorRadius < 0)) {
        issues.push('minorRadius must be a non-negative finite number');
    }
    return { valid: issues.length === 0, issues };
}

function isString(value: unknown): value is string {
    return typeof value === 'string';
}

/** Validate an edge fingerprint shape. */
export function validateEdgeFingerprint(fp: EdgeFingerprint): TopologyValidationResult {
    const issues: string[] = [];
    if (!isString(fp.curveType)) {
        issues.push('curveType is required');
    } else if (!CURVE_TYPES.includes(fp.curveType)) {
        issues.push(`curveType must be one of ${CURVE_TYPES.join(', ')}`);
    }
    if (!isNumber(fp.length) || fp.length <= 0) {
        issues.push('length must be a positive finite number');
    }
    if (!isPoint3(fp.start)) {
        issues.push('start must be a [x, y, z] tuple');
    }
    if (!isPoint3(fp.end)) {
        issues.push('end must be a [x, y, z] tuple');
    }
    if (fp.center !== undefined && !isPoint3(fp.center)) {
        issues.push('center must be a [x, y, z] tuple');
    }
    return { valid: issues.length === 0, issues };
}

/** Validate a topology reference. */
export function validateTopologyRef(ref: TopologyRef): TopologyValidationResult {
    const issues: string[] = [];
    if (!ref.featureId || typeof ref.featureId !== 'string') {
        issues.push('featureId must be a non-empty string');
    }
    if (ref.kind !== 'face' && ref.kind !== 'edge') {
        issues.push("kind must be 'face' or 'edge'");
    }
    if (!ref.fingerprint || typeof ref.fingerprint !== 'object') {
        issues.push('fingerprint must be an object');
    } else {
        const fpResult =
            ref.kind === 'edge'
                ? validateEdgeFingerprint(ref.fingerprint as EdgeFingerprint)
                : validateFaceFingerprint(ref.fingerprint as FaceFingerprint);
        for (const sub of fpResult.issues) {
            issues.push(`fingerprint.${sub}`);
        }
    }
    return { valid: issues.length === 0, issues };
}
