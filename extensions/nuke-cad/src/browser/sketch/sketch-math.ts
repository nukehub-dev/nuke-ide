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
 * Pure geometric helpers for mapping between screen, world, and sketch-local
 * coordinates. No three.js or DOM dependencies.
 *
 * @module nuke-cad/browser/sketch
 */

import { type TopologyRef } from '../../common/topology-refs';

/** Supported datum plane identifiers. */
export type DatumKind = 'XY' | 'YZ' | 'XZ' | 'face' | 'threePoint' | 'midplane' | 'line2Point';

/** A literal 3D point, as stored on `threePoint`/`line2Point` datums. */
export type DatumPoint = readonly [number, number, number];

/** A 3D vector/point. */
export interface Vec3 {
    readonly x: number;
    readonly y: number;
    readonly z: number;
}

/** A 2D point in sketch-local coordinates. */
export interface Point2 {
    readonly x: number;
    readonly y: number;
}

/** A datum plane definition. */
export interface DatumPlane {
    readonly kind: DatumKind;
    readonly offset: number;
    readonly origin: Vec3;
    readonly normal: Vec3;
    readonly xAxis: Vec3;
    readonly yAxis: Vec3;
    /** Source face reference for ``face`` datums. */
    readonly reference?: TopologyRef;
}

/** A ray in world space. */
export interface Ray3 {
    readonly origin: Vec3;
    readonly direction: Vec3;
}

function v3(x: number, y: number, z: number): Vec3 {
    return { x, y, z };
}

function dot(a: Vec3, b: Vec3): number {
    return a.x * b.x + a.y * b.y + a.z * b.z;
}

function sub(a: Vec3, b: Vec3): Vec3 {
    return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function add(a: Vec3, b: Vec3): Vec3 {
    return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function scale(a: Vec3, s: number): Vec3 {
    return { x: a.x * s, y: a.y * s, z: a.z * s };
}

/**
 * Build a datum plane from a kind and offset.
 *
 * Offset is applied along the plane normal: XY is offset along +Z, YZ along +X,
 * XZ along +Y. For ``face`` datums use {@link buildDatumPlaneFromFace}.
 */
export function buildDatumPlane(kind: Exclude<DatumKind, 'face'>, offset = 0): DatumPlane {
    switch (kind) {
        case 'XY':
            return {
                kind,
                offset,
                origin: v3(0, 0, offset),
                normal: v3(0, 0, 1),
                xAxis: v3(1, 0, 0),
                yAxis: v3(0, 1, 0)
            };
        case 'YZ':
            return {
                kind,
                offset,
                origin: v3(offset, 0, 0),
                normal: v3(1, 0, 0),
                xAxis: v3(0, 1, 0),
                yAxis: v3(0, 0, 1)
            };
        case 'XZ':
            return {
                kind,
                offset,
                origin: v3(0, offset, 0),
                normal: v3(0, 1, 0),
                xAxis: v3(1, 0, 0),
                yAxis: v3(0, 0, 1)
            };
        default:
            throw new Error(`Unsupported datum kind '${kind}'`);
    }
}

function v3len(v: Vec3): number {
    return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function v3normalize(v: Vec3): Vec3 {
    const len = v3len(v);
    if (len < 1e-12) {
        return v;
    }
    return v3(v.x / len, v.y / len, v.z / len);
}

function v3cross(a: Vec3, b: Vec3): Vec3 {
    return v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
}

/**
 * Build a datum plane from a picked face reference.
 *
 * The origin is the face centroid plus ``offset`` along the face normal. The
 * X/Y axes are derived deterministically from the normal so sketches placed on
 * the same face share a consistent coordinate system. The basis matches
 * ``_deterministic_x_dir`` in the Python backend (and the fingerprint normal
 * convention: outward normals for REVERSED faces), so sketch coordinates map
 * identically on both sides.
 *
 * @throws Error if the reference fingerprint lacks a planar normal.
 */
export function buildDatumPlaneFromFace(reference: TopologyRef, offset = 0): DatumPlane {
    const fp = reference.fingerprint;
    if (!('normal' in fp) || fp.normal === undefined) {
        throw new Error('Face datum requires a planar face with a normal');
    }
    const center = v3(fp.center[0], fp.center[1], fp.center[2]);
    const normal = v3normalize(v3(fp.normal[0], fp.normal[1], fp.normal[2]));
    // Mirrors `_deterministic_x_dir` in python/feature_builder.py: for normals
    // near world Z the cross product with (0, 0, 1) collapses, so the backend
    // falls back to world X.
    const xAxis = deterministicXAxis(normal);
    const yAxis = v3normalize(v3cross(normal, xAxis));
    const origin = v3(center.x + normal.x * offset, center.y + normal.y * offset, center.z + normal.z * offset);
    return {
        kind: 'face',
        offset,
        origin,
        normal,
        xAxis,
        yAxis,
        reference
    };
}

/**
 * Derive the deterministic in-plane X axis for a datum normal.
 *
 * Mirrors `_deterministic_x_dir` in the Python backend (and
 * {@link buildDatumPlaneFromFace}): for normals near world Z the cross
 * product with (0, 0, 1) collapses, so the basis falls back to world X.
 */
function deterministicXAxis(normal: Vec3): Vec3 {
    return Math.abs(normal.z) < 0.999 ? v3normalize(v3cross(v3(0, 0, 1), normal)) : v3(1, 0, 0);
}

/**
 * Build a datum plane through three non-collinear points.
 *
 * The origin is the first point plus ``offset`` along the plane normal
 * (``normalize(cross(p2 - p1, p3 - p1))``). The X/Y axes follow the same
 * world-Z rule as {@link buildDatumPlaneFromFace} so sketches placed on the
 * same plane share a consistent coordinate system.
 *
 * @throws Error if the points are coincident or collinear (triangle area at
 * or below 1e-9, matching the backend's `_three_point_frame`).
 */
export function buildDatumPlaneFromPoints(p1: DatumPoint, p2: DatumPoint, p3: DatumPoint, offset = 0): DatumPlane {
    const a = v3(p1[0], p1[1], p1[2]);
    const b = v3(p2[0], p2[1], p2[2]);
    const c = v3(p3[0], p3[1], p3[2]);
    const cross = v3cross(sub(b, a), sub(c, a));
    const area = 0.5 * v3len(cross);
    if (area <= 1e-9) {
        throw new Error('Three-point datum requires three non-collinear points');
    }
    const normal = v3normalize(cross);
    const xAxis = deterministicXAxis(normal);
    const yAxis = v3normalize(v3cross(normal, xAxis));
    const origin = add(a, scale(normal, offset));
    return {
        kind: 'threePoint',
        offset,
        origin,
        normal,
        xAxis,
        yAxis
    };
}

/**
 * Build a datum plane midway between two planar faces.
 *
 * Both fingerprints must carry a planar normal; the faces must be parallel
 * within a 1-degree dihedral tolerance (matching the backend's
 * `_midplane_frame_from_normals`). The normal is oriented from the first face
 * toward the second (negating the first normal when it points away), and the
 * origin is the face-center midpoint plus ``offset`` along the normal. The
 * X/Y axes follow the same world-Z rule as {@link buildDatumPlaneFromFace}.
 *
 * @throws Error if either face lacks a planar normal or the faces are not parallel.
 */
export function buildDatumPlaneFromMidplane(refA: TopologyRef, refB: TopologyRef, offset = 0): DatumPlane {
    const fpA = refA.fingerprint;
    const fpB = refB.fingerprint;
    if (!('normal' in fpA) || fpA.normal === undefined || !('normal' in fpB) || fpB.normal === undefined) {
        throw new Error('Midplane datum requires two planar faces with normals');
    }
    const n1 = v3normalize(v3(fpA.normal[0], fpA.normal[1], fpA.normal[2]));
    const n2 = v3normalize(v3(fpB.normal[0], fpB.normal[1], fpB.normal[2]));
    if (Math.abs(dot(n1, n2)) < Math.cos(Math.PI / 180)) {
        throw new Error('Midplane datum requires two parallel faces');
    }
    const c1 = v3(fpA.center[0], fpA.center[1], fpA.center[2]);
    const c2 = v3(fpB.center[0], fpB.center[1], fpB.center[2]);
    const normal = dot(n1, sub(c2, c1)) < 0 ? scale(n1, -1) : n1;
    const midpoint = scale(add(c1, c2), 0.5);
    const origin = add(midpoint, scale(normal, offset));
    const xAxis = deterministicXAxis(normal);
    const yAxis = v3normalize(v3cross(normal, xAxis));
    return {
        kind: 'midplane',
        offset,
        origin,
        normal,
        xAxis,
        yAxis
    };
}

/** Intersect a ray with a datum plane; returns undefined when parallel. */
export function intersectRayPlane(ray: Ray3, plane: DatumPlane): Vec3 | undefined {
    const denom = dot(ray.direction, plane.normal);
    if (Math.abs(denom) < 1e-12) {
        return undefined;
    }
    const t = dot(sub(plane.origin, ray.origin), plane.normal) / denom;
    return add(ray.origin, scale(ray.direction, t));
}

/** Convert a world point on the datum plane to sketch-local 2D coordinates. */
export function worldToSketch(world: Vec3, plane: DatumPlane): Point2 {
    const local = sub(world, plane.origin);
    return {
        x: dot(local, plane.xAxis),
        y: dot(local, plane.yAxis)
    };
}

/** Convert sketch-local 2D coordinates to a world point on the datum plane. */
export function sketchToWorld(point: Point2, plane: DatumPlane): Vec3 {
    return add(plane.origin, add(scale(plane.xAxis, point.x), scale(plane.yAxis, point.y)));
}

/**
 * Convert a screen pixel snap radius to model units for an orthographic camera.
 *
 * @param pixelRadius Radius in pixels (e.g. 12).
 * @param orthoHeight Visible world height of the orthographic frustum.
 * @param canvasHeight Canvas height in pixels.
 */
export function pixelRadiusToModelUnits(pixelRadius: number, orthoHeight: number, canvasHeight: number): number {
    if (canvasHeight <= 0 || !Number.isFinite(orthoHeight)) {
        return pixelRadius;
    }
    return (pixelRadius * orthoHeight) / canvasHeight;
}

/** Squared distance between two 2D points. */
export function dist2(a: Point2, b: Point2): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
}

/** Distance between two 2D points. */
export function dist(a: Point2, b: Point2): number {
    return Math.sqrt(dist2(a, b));
}

/** Project a point onto a line segment; clamps to the segment end points. */
export function projectPointOntoSegment(point: Point2, segStart: Point2, segEnd: Point2): Point2 {
    const ab = { x: segEnd.x - segStart.x, y: segEnd.y - segStart.y };
    const denom = ab.x * ab.x + ab.y * ab.y;
    if (denom < 1e-12) {
        return segStart;
    }
    const t = Math.max(0, Math.min(1, ((point.x - segStart.x) * ab.x + (point.y - segStart.y) * ab.y) / denom));
    return { x: segStart.x + ab.x * t, y: segStart.y + ab.y * t };
}

/** Compute a default orthographic camera view size for a sketch plane. */
export function defaultSketchViewSize(): number {
    return 20;
}
