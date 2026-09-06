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
 * Edge-picking helpers for the CAD viewport.
 *
 * Maps three.js raycast hits against tessellated edge lines to stable
 * fingerprint-based {@link TopologyRef} objects for fillet, chamfer, draft, and
 * shell features. Edge picks bind to the owning body's current tip feature so
 * references survive downstream modifications on the same body.
 *
 * @module nuke-cad/browser/widgets
 */

import * as THREE from 'three';
import { validateTopologyRef, type TopologyRef, type EdgeFingerprint } from '../../../common/topology-refs';
import { type DrawingDimensionKind } from '../../../common/cad-drawing';
import { pointerToNdc } from './face-picker';

export { pointerToNdc };

/** Per-edge tessellation data consumed by the viewport. */
export interface TessEdgeData {
    readonly edgeId: number;
    /** XYZ triplets, `pointCount * 3` entries. */
    readonly positions: Float32Array;
    readonly pointCount: number;
    readonly bodyId?: string;
    readonly fingerprint?: EdgeFingerprint;
}

/** A single raycast hit against a tessellated edge line. */
export interface EdgePickHit {
    readonly solidId: number;
    readonly edgeId: number;
    readonly bodyId?: string;
    readonly line: THREE.Line;
    readonly fingerprint?: EdgeFingerprint;
}

/**
 * Build a TopologyRef for a picked edge.
 *
 * The reference points at the current tip feature of the body that owns the
 * picked edge. ``resolveBodyTipFeature`` maps a body id to the most recent
 * non-suppressed solid-producing feature targeting that body; when the mapping
 * is unavailable the reference falls back to the supplied fallback feature id.
 */
export function buildEdgeTopologyRef(
    fallbackFeatureId: string,
    hit: EdgePickHit,
    resolveBodyTipFeature?: (bodyId: string) => string | undefined
): TopologyRef | undefined {
    if (hit.fingerprint === undefined) {
        return undefined;
    }
    const featureId =
        hit.bodyId !== undefined && resolveBodyTipFeature !== undefined
            ? (resolveBodyTipFeature(hit.bodyId) ?? fallbackFeatureId)
            : fallbackFeatureId;
    return {
        featureId,
        kind: 'edge',
        fingerprint: hit.fingerprint
    };
}

/** Build a THREE.Line object from tessellated edge points. */
export function buildEdgeLine(solidId: number, edge: TessEdgeData, material: THREE.LineBasicMaterial): THREE.Line {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(edge.positions, 3));
    const line = new THREE.Line(geometry, material);
    line.userData = {
        solidId,
        edgeId: edge.edgeId,
        bodyId: edge.bodyId,
        fingerprint: edge.fingerprint
    };
    return line;
}

/**
 * Raycast against the viewport edge lines and return the closest hit.
 *
 * ``lines`` is expected to be the array of per-edge lines built by
 * {@link buildEdgeLine}; each line's ``userData`` carries ``solidId``,
 * ``edgeId``, ``bodyId`` and the geometric fingerprint.
 */
export function raycastEdge(
    lines: readonly THREE.Line[],
    raycaster: THREE.Raycaster,
    ndc: { x: number; y: number },
    camera: THREE.Camera,
    threshold = 0.05
): EdgePickHit | undefined {
    raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera);
    raycaster.params.Line = { threshold };
    const intersects = raycaster.intersectObjects([...lines], false);
    if (intersects.length === 0) {
        return undefined;
    }
    const object = intersects[0].object;
    const data = object.userData as {
        solidId?: number;
        edgeId?: number;
        bodyId?: string;
        fingerprint?: EdgeFingerprint;
    };
    if (typeof data.solidId !== 'number' || typeof data.edgeId !== 'number') {
        return undefined;
    }
    return {
        solidId: data.solidId,
        edgeId: data.edgeId,
        bodyId: data.bodyId,
        line: object as THREE.Line,
        fingerprint: data.fingerprint
    };
}

/** Reusable highlighter that overlays a brighter, thicker line on the hovered edge. */
export class EdgeHighlighter {
    private readonly highlightLine: THREE.Line;
    private highlighted?: THREE.Line;

    constructor(color: THREE.Color) {
        const material = new THREE.LineBasicMaterial({
            color,
            transparent: true,
            opacity: 0.9,
            linewidth: 3,
            depthTest: false
        });
        this.highlightLine = new THREE.Line(new THREE.BufferGeometry(), material);
        this.highlightLine.name = 'cad-edge-highlight';
        this.highlightLine.visible = false;
        this.highlightLine.renderOrder = 1001;
    }

    /** Attach the highlight line to a parent (the model group). */
    attach(parent: THREE.Object3D): void {
        parent.add(this.highlightLine);
    }

    /** Detach and dispose resources. */
    dispose(): void {
        this.highlightLine.geometry.dispose();
        (this.highlightLine.material as THREE.Material).dispose();
        this.highlightLine.removeFromParent();
    }

    /** Highlight the given source line. */
    highlight(line: THREE.Line): void {
        if (this.highlighted === line) {
            return;
        }
        this.highlighted = line;
        this.highlightLine.geometry.dispose();
        this.highlightLine.geometry = line.geometry.clone();
        this.highlightLine.matrix.copy(line.matrixWorld);
        this.highlightLine.matrixAutoUpdate = false;
        this.highlightLine.visible = true;
    }

    /** Clear the highlight. */
    clear(): void {
        this.highlighted = undefined;
        this.highlightLine.visible = false;
    }

    /** True when an edge is currently highlighted. */
    get isActive(): boolean {
        return this.highlighted !== undefined;
    }
}

// *****************************************************************************
// Drawing-dimension viewport pick (drawings phase, brief §4 revision).
//
// The brief assumed a backend projected-edge → TopologyRef map that does not
// exist (HLR output carries no source identity, by design). Instead, the
// Drawing Sheet dimension tool reuses this viewport's edge picker: each
// clicked edge yields its geometric fingerprint as a `TopologyRef` target
// (one edge for radius/diameter, two for distance). The helpers below are
// pure so the pick → targets assembly is unit-testable; the broker beneath
// them is the only cross-widget channel between the Drawing Sheet widget
// (requests picks, accumulates targets, commits via `addDimension`) and the
// CAD viewport widget (edge-pick mode, hover highlight, Cancel).
// *****************************************************************************

/** Number of edge targets a dimension kind needs (brief §2). */
export function drawingDimensionTargetsNeeded(kind: DrawingDimensionKind): 1 | 2 {
    return kind === 'distance' ? 2 : 1;
}

/** Result of accumulating one more picked edge into a dimension's targets. */
export interface DrawingDimensionTargetState {
    readonly targets: TopologyRef[];
    readonly complete: boolean;
}

function sameFingerprint(a: TopologyRef['fingerprint'], b: TopologyRef['fingerprint']): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Accumulate one viewport edge pick into a dimension's targets.
 *
 * Invalid (non-edge or malformed) refs are dropped, previously accumulated
 * invalid entries are filtered, exact-duplicate fingerprints are ignored (a
 * distance from an edge to itself is degenerate), and the list is capped at
 * the kind's arity. `complete` turns true exactly when the kind's target
 * count is reached.
 */
export function appendDrawingDimensionTarget(
    existing: readonly TopologyRef[],
    next: TopologyRef,
    kind: DrawingDimensionKind
): DrawingDimensionTargetState {
    const needed = drawingDimensionTargetsNeeded(kind);
    const kept = existing.filter((ref) => ref.kind === 'edge' && validateTopologyRef(ref).valid).slice(0, needed);
    if (next.kind !== 'edge' || validateTopologyRef(next).valid !== true) {
        return { targets: [...kept], complete: kept.length >= needed };
    }
    const duplicate = kept.some((ref) => sameFingerprint(ref.fingerprint, next.fingerprint));
    const extended = (duplicate ? kept : [...kept, next]).slice(0, needed);
    return { targets: [...extended], complete: extended.length >= needed };
}

/** Cross-widget request: the Drawing Sheet dimension tool asks the 3D viewport for edge picks. */
export interface DrawingDimensionPickRequest {
    readonly kind: DrawingDimensionKind;
}

let activeDrawingDimensionPickRequest: DrawingDimensionPickRequest | undefined;
const drawingDimensionPickRequestListeners = new Set<(request: DrawingDimensionPickRequest | undefined) => void>();
const drawingDimensionEdgeHitListeners = new Set<(ref: TopologyRef) => void>();

function notifyDrawingDimensionPickRequest(): void {
    for (const listener of [...drawingDimensionPickRequestListeners]) {
        listener(activeDrawingDimensionPickRequest);
    }
}

/**
 * Enter viewport edge-pick mode for a drawing dimension.
 *
 * Notifies the CAD viewport widget (banner + hover highlight + Cancel);
 * each clicked edge is published back through
 * {@link publishDrawingDimensionEdgeHit}. The mode stays active across
 * picks (distance needs two) until {@link cancelDrawingDimensionPick}.
 */
export function requestDrawingDimensionPick(request: DrawingDimensionPickRequest): void {
    activeDrawingDimensionPickRequest = { kind: request.kind };
    notifyDrawingDimensionPickRequest();
}

/**
 * Leave viewport edge-pick mode.
 *
 * Called by the Drawing Sheet widget after committing the dimension (or on
 * user cancel) and by the viewport's own Cancel affordances; a no-op when
 * no request is active. The viewport exits its pick mode on notification.
 */
export function cancelDrawingDimensionPick(): void {
    if (activeDrawingDimensionPickRequest === undefined) {
        return;
    }
    activeDrawingDimensionPickRequest = undefined;
    notifyDrawingDimensionPickRequest();
}

/** The active drawing-dimension pick request, if any. */
export function getDrawingDimensionPickRequest(): DrawingDimensionPickRequest | undefined {
    return activeDrawingDimensionPickRequest;
}

/** Subscribe to pick-request changes; returns an unsubscribe function. */
export function onDrawingDimensionPickRequest(listener: (request: DrawingDimensionPickRequest | undefined) => void): () => void {
    drawingDimensionPickRequestListeners.add(listener);
    return () => {
        drawingDimensionPickRequestListeners.delete(listener);
    };
}

/**
 * Publish one picked edge's `TopologyRef` to the Drawing Sheet widget.
 *
 * The viewport builds the ref with {@link buildEdgeTopologyRef} (fingerprint
 * identity, guarded against missing fingerprints at the call site) and stays
 * in pick mode; the sheet accumulates and commits.
 */
export function publishDrawingDimensionEdgeHit(ref: TopologyRef): void {
    for (const listener of [...drawingDimensionEdgeHitListeners]) {
        listener(ref);
    }
}

/** Subscribe to picked-edge hits; returns an unsubscribe function. */
export function onDrawingDimensionEdgeHit(listener: (ref: TopologyRef) => void): () => void {
    drawingDimensionEdgeHitListeners.add(listener);
    return () => {
        drawingDimensionEdgeHitListeners.delete(listener);
    };
}
