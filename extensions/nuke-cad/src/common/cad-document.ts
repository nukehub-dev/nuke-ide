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
 * The ``import`` feature type is additive within version 3 (no version bump, no
 * migration): it turns external STEP/IGES/BREP solids into body shapes. The
 * ``coilSweep`` feature type is likewise additive v3: it lofts a rectangular
 * section along a document curve without consuming a sketch.
 *
 * @module nuke-cad/common
 */

import { validateTopologyRef, type TopologyRef } from './topology-refs';
import {
    validateDrawingSheet,
    type DrawingDimension,
    type DrawingSheet,
    type DrawingSheetSize,
    type DrawingValidationSink,
    type DrawingView
} from './cad-drawing';
import {
    ASSEMBLY_SCHEMA_VERSION,
    validateAssemblyDocument,
    type AssemblyConnector,
    type AssemblyInstance,
    type AssemblyMate
} from './assembly-document';

export type { DrawingDimension, DrawingSheet, DrawingSheetSize, DrawingValidationSink, DrawingView };

/** Current `.nuke-cad` schema version. */
export const NUKE_CAD_SCHEMA_VERSION = 3;

/** Supported datum plane kinds. */
export type DatumKind = 'XY' | 'YZ' | 'XZ' | 'offset' | 'face' | 'threePoint' | 'midplane' | 'line2Point';

/** A datum plane or face reference on which a sketch can be placed. */
export interface DatumPlane {
    id: string;
    kind: DatumKind;
    name: string;
    /** Offset distance for `offset` datums. */
    offset?: number;
    /** Topological face reference for `face` datums (sketch-on-face). */
    reference?: TopologyRef;
    /**
     * Literal 3D points for `threePoint` (exactly 3, non-collinear) and
     * `line2Point` (exactly 2, distinct) datums.
     */
    points?: CurvePoint[];
    /** Face references for `midplane` datums (exactly 2 planar faces). */
    faces?: TopologyRef[];
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

/**
 * Display-only appearance override for one body (viewport color and opacity).
 *
 * Absent means the body follows the shared theme-adaptive material. This block
 * is never read by the geometry backend: it must never affect builds, exports,
 * or codegen. At least one field must be present when an override exists.
 */
export interface BodyAppearance {
    /** Solid fill color as `#rrggbb`. */
    color?: string;
    /** Surface opacity in the inclusive range 0–1. */
    opacity?: number;
}

/** A named, label-bearing body in the document. */
export interface BodyDef {
    id: string;
    name: string;
    /** Optional region-manifest label applied to all solids of this body. */
    label?: string;
    /**
     * Optional in-CAD material tag (bare name, e.g. `UO2` — never `mat:`-prefixed).
     * Exported through the `.regions.json` sidecar as `{ selector: <label>, material: <tag> }`.
     */
    material?: string;
    /**
     * Optional display-only appearance override (color and/or opacity).
     * The geometry backend never reads this block — it never affects builds,
     * exports, or codegen.
     */
    appearance?: BodyAppearance;
}

/** Maximum in-CAD material tag length (free-text input bound). */
export const BODY_MATERIAL_MAX_LENGTH = 64;

/**
 * Validate an in-CAD material tag against the free-text input rules.
 *
 * Returns a human-readable hint when the tag is invalid, or undefined when it
 * is valid. Empty (or all-whitespace) input clears the tag — valid here, since
 * the UI maps it to `material: undefined` (mirroring `setBodyLabel` delete
 * semantics); stored tags must still be non-empty after trimming, which the
 * schema check enforces separately.
 */
export function validateBodyMaterialTag(value: string): string | undefined {
    const tag = value.trim();
    if (tag.length === 0) {
        return undefined;
    }
    if (tag.length > BODY_MATERIAL_MAX_LENGTH) {
        return `Material name must be ${BODY_MATERIAL_MAX_LENGTH} characters or fewer`;
    }
    if (tag.startsWith('mat:')) {
        return `Drop the 'mat:' prefix — material names are stored bare (e.g. UO2)`;
    }
    if (tag.includes(':') || tag.includes('/')) {
        return `Material name must not contain ':' or '/' (DAGMC tag separators)`;
    }
    return undefined;
}

/**
 * Normalize raw material-tag input from the body-row text field.
 *
 * Empty (or all-whitespace) input clears the tag — the caller stores
 * `material: undefined`, mirroring `setBodyLabel` delete semantics. Otherwise
 * the trimmed tag is validated and returned, or the hint to display is
 * returned. The feature-tree body row drives this; the store enforces the
 * same rules at commit time.
 */
export function normalizeBodyMaterialInput(value: string): { material?: string } | { error: string } {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        return {};
    }
    const reason = validateBodyMaterialTag(value);
    if (reason !== undefined) {
        return { error: reason };
    }
    return { material: trimmed };
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
    | 'coilSweep'
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
    | 'hole'
    | 'primitive'
    | 'multiTransform'
    | 'lattice'
    | 'defeature'
    | 'translate'
    | 'import';

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
    | 'coilSweep'
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
    | 'primitive'
    | 'lattice'
    | 'multiTransform'
    | 'import';

/** Extrusion end condition for pad/pocket. */
export type ExtrudeEnd = 'blind' | 'upToFirst' | 'upToLast' | 'upToFace' | 'throughAll';

/** Revolve end condition for revolve/groove (the full UpTo set stays pad/pocket-only). */
export type RevolveEnd = 'blind' | 'throughAll';

/** Parameters common to extrude-like features. */
export interface ExtrudeParams {
    length?: number;
    angle?: number;
    axis?: 'x' | 'y' | 'z';
    symmetric?: boolean;
    /** Extrusion end condition; default `blind` (length required iff blind). */
    end?: ExtrudeEnd;
    /** Split `length` equally both ways (same convention as `symmetric`). */
    twoSided?: boolean;
    upToFace?: TopologyRef;
    /** Target body id for an up-to-body termination; mutually exclusive with upToFace. */
    upToBody?: string;
}

/** Parameters for revolve-like features. */
export interface RevolveParams {
    axis: 'x' | 'y' | 'z';
    angle: number;
    /** Revolve end condition; default `blind` (throughAll spans the body). */
    end?: RevolveEnd;
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
    /** When true the swept tool cuts from the body instead of merging (default false). */
    readonly subtractive?: boolean;
}

/** Parameters for a rectangular-section sweep along a curve (coil geometry). */
export interface CoilSweepParams {
    /** Document curve id providing the centerline wire. */
    readonly pathCurveId: string;
    /** Section width in document units; positive finite. */
    readonly width: number;
    /** Section height in document units; positive finite. */
    readonly height: number;
    /** Constant section tilt from the tangent-normal plane at the start, degrees. Default 0. */
    readonly tiltDeg?: number;
    /** Additional total twist around the path from start to end, degrees. Default 0. */
    readonly twistDeg?: number;
    /** Loft stations along the curve. Default 60, integer in [8, 720]. */
    readonly stations?: number;
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
    /** Optional neutral-plane face reference (pull direction unchanged). */
    neutralPlane?: TopologyRef;
}

/** Parameters for a linear pattern. */
export interface LinearPatternParams {
    /** Source sketch-based solid feature id (pad/pocket/revolve/groove). */
    source: string;
    count: number;
    /** Spacing between instances along the axis. */
    spacing: number;
    /** Axis through the origin; mutually exclusive with axisDatumId. */
    axis?: 'x' | 'y' | 'z';
    /** Datum axis id; mutually exclusive with axis. */
    axisDatumId?: string;
    /** Per-instance uniform scale about each instance's bbox center (default 1). */
    scale?: number;
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
    /** Per-instance uniform scale about each instance's bbox center (default 1). */
    scale?: number;
}

/** Parameters for a mirror feature. */
export interface MirrorParams {
    /** Source sketch-based solid feature id (pad/pocket/revolve/groove). */
    source: string;
    /** Coordinate plane; mutually exclusive with planeDatumId. */
    plane?: 'XY' | 'YZ' | 'XZ';
    /** Datum plane id; mutually exclusive with plane. */
    planeDatumId?: string;
    /** Per-instance uniform scale about each instance's bbox center (default 1). */
    scale?: number;
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
    counterdrillDiameter?: number;
    counterdrillDepth?: number;
    /** Taper angle in (0, 45] degrees. */
    taperAngle?: number;
    /** Drill-point cone angle in (0, 180) degrees; omitted = flat bottom. */
    drillPointAngle?: number;
    /** Stored thread callout (default 'none'); 'modeled' is blind/simple holes only. */
    thread?: 'none' | 'cosmetic' | 'modeled';
}

/** Additive primitive shapes and their dimension arities. */
export type PrimitiveShape = 'box' | 'cylinder' | 'sphere' | 'cone' | 'torus';

/** Parameters for an additive primitive (box/cylinder/sphere/cone/torus). */
export interface PrimitiveParams {
    shape: PrimitiveShape;
    /**
     * All-positive dimensions: box `[dx, dy, dz]`, cylinder/cone `[r, h]`,
     * sphere `[r]`, torus `[R, r]`.
     */
    dimensions: number[];
    /** Datum the primitive is placed on; defaults to `datum-xy`. */
    datumId?: string;
    /** When true the primitive tool cuts from the body instead of merging (default false). */
    subtractive?: boolean;
}

/** Parameters for a multiTransform (cartesian product of two patterns/mirrors). */
export interface MultiTransformParams {
    /** First pattern/mirror feature id (earlier in document order). */
    first: string;
    /** Second pattern/mirror feature id. */
    second: string;
}

/** Maximum cells per lattice feature; above this the build fails with a stepwise-build hint. */
export const LATTICE_MAX_CELLS = 2500;

/** Parameters for a lattice: one source solid replicated on a planar rectangular or hexagonal grid. */
export interface LatticeParams {
    /** Source solid-producing feature id (same body, earlier in document order; never a pattern/mirror/lattice). */
    source: string;
    /** Grid geometry: rectangular rows/cols or hexagonal rows/cols-or-rings. */
    latticeType: 'rectangular' | 'hexagonal';
    /** Rectangular/hex-offset grid rows (>= 1); mutually exclusive with rings. */
    rows?: number;
    /** Rectangular/hex-offset grid columns (>= 1); mutually exclusive with rings. */
    cols?: number;
    /** Hex ring count around the center cell (>= 0); mutually exclusive with rows/cols. */
    rings?: number;
    /** Center-to-center pitch (positive); the X pitch for rectangular grids. */
    pitch: number;
    /** Rectangular-only Y pitch (default = pitch). */
    pitchY?: number;
    /** Hexagonal-only cell orientation (default 'pointyTop'). */
    orientation?: 'flatTop' | 'pointyTop';
    /** Lattice plane datum (planar only; default 'datum-xy'). */
    datumId?: string;
    /** In-plane offset (default [0, 0]). */
    origin?: [number, number];
    /** Cell label prefix (default: body label, else the source feature name). */
    labelPrefix?: string;
    /** Per-instance uniform scale about each instance's bbox center (default 1). */
    scale?: number;
}

/** Parameters for defeature (face removal). */
export interface DefeatureParams {
    faces: TopologyRef[];
}

/** Parameters for translate (rigid move of a body's accumulated shape). */
export interface TranslateParams {
    /** Translation offsets [dx, dy, dz] in document units; applied 1:1. Must be non-zero. */
    vector: [number, number, number];
}

/** External CAD source formats accepted by `import` features. */
export type ImportSourceFormat = 'step' | 'iges' | 'brep';

/** Units accepted for `import` sources (also the unit override vocabulary). */
export type ImportSourceUnit = 'mm' | 'cm' | 'm';

/** Accepted external CAD source formats for `import` features. */
export const IMPORT_SOURCE_FORMATS: readonly ImportSourceFormat[] = ['step', 'iges', 'brep'];

/** Units accepted for `import` source-unit overrides. */
export const IMPORT_SOURCE_UNITS: readonly ImportSourceUnit[] = ['mm', 'cm', 'm'];

/** Fingerprint of one source solid, captured at inspection time. */
export interface ImportSolidSignature {
    /** Face count in the source solid. */
    readonly faceCount: number;
    /** Volume in the source file's effective unit. */
    readonly volume: number;
}

/** One selected source solid (a hint plus optional fingerprint, never identity). */
export interface ImportSolidPick {
    /** 1-based explorer-order index in the source file (a hint, not identity). */
    readonly index: number;
    /** Fingerprint captured at inspection; used for repair/validation. */
    readonly signature?: ImportSolidSignature;
}

/** Which source solids an `import` feature contributes to its body. */
export type ImportSelection = { readonly mode: 'all' } | { readonly mode: 'solids'; readonly solids: readonly ImportSolidPick[] };

/** Rigid pre-placement applied to an imported shape before later features. */
export interface ImportPlacement {
    /** Translation in document units. */
    readonly translate?: readonly [number, number, number];
    /** Intrinsic XYZ rotation in degrees, applied before translation. */
    readonly rotateDegrees?: readonly [number, number, number];
}

/** Parameters for an imported-body feature (external STEP/IGES/BREP snapshot). */
export interface ImportParams {
    /** Document-relative POSIX path preferred (`./w7x.parts/source.step`). */
    readonly sourcePath: string;
    /** Lowercase SHA-256 hex of the source bytes at import time. */
    readonly sourceHash: string;
    /** Byte size at import time; advisory freshness probe. */
    readonly sourceSize?: number;
    /** Inferred from the extension when absent. */
    readonly sourceFormat?: ImportSourceFormat;
    /**
     * Override the file's declared unit. The W7-X STEP declares millimetres but
     * stores metre-scale numbers; the generator sets `sourceUnit: 'm'`.
     */
    readonly sourceUnit?: ImportSourceUnit;
    /** Which source solids this feature contributes to its body. */
    readonly selection: ImportSelection;
    /** Rigid pre-placement applied to the selected shape before later features. */
    readonly placement?: ImportPlacement;
    /** Safety cap; reject source files with more solids. Default 500. */
    readonly maxSolids?: number;
}

/** Union of all feature parameter shapes. */
export type FeatureParams =
    | ExtrudeParams
    | RevolveParams
    | SweepParams
    | PipeParams
    | LoftParams
    | HelicalSweepParams
    | CoilSweepParams
    | FilletParams
    | ShellParams
    | DraftParams
    | LinearPatternParams
    | CircularPatternParams
    | MirrorParams
    | LatticeParams
    | BooleanParams
    | HoleParams
    | PrimitiveParams
    | MultiTransformParams
    | DefeatureParams
    | TranslateParams
    | ImportParams
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

/** Declared length unit for a `.nuke-cad` document. Absent = legacy unitless. */
export type DocumentUnits = 'mm' | 'cm' | 'm';

/**
 * Optional assembly section of a `.nuke-cad` document (additive, schema v3 —
 * no migration: absent means a single-part document that builds exactly as
 * before). Instance/connector/mate types are imported from the frozen
 * `assembly-document.ts` spec; an empty `groundedInstanceId` likewise means
 * single-part (explicit grounding only, never defaulted).
 */
export interface NukeCadAssembly {
    instances: AssemblyInstance[];
    connectors: AssemblyConnector[];
    mates: AssemblyMate[];
    groundedInstanceId: string;
}

/** Which viewport measure tool a saved measurement was captured with. */
export type SavedMeasurementKind = 'distance' | 'angle' | 'radius';

/**
 * One pinned viewport measurement persisted in the `.nuke-cad` document
 * (additive, schema v3 — no migration: absent means no saved measurements,
 * same convention as `drawings`).
 *
 * Points are `[x, y, z]` tuples in model units: distance carries exactly 2
 * (the measured endpoints), angle exactly 3 (A, vertex B, C), radius exactly
 * 2 (circle center + a rim point, the radius deriving as their distance).
 * `label` is the formatted value text captured at pin time; `createdAt` is
 * an ISO-8601 timestamp. The geometry backend never reads this block — it
 * must never affect builds, exports, or codegen.
 */
export interface SavedMeasurement {
    id: string;
    kind: SavedMeasurementKind;
    points: CurvePoint[];
    label: string;
    createdAt: string;
}

/**
 * One saved viewport camera persisted in the `.nuke-cad` document (additive,
 * schema v3 — no migration: absent means no saved views, the same convention
 * as `measurements` and `drawings`).
 *
 * `position`, `target`, and `up` are `[x, y, z]` tuples in world space;
 * `name` is user-facing and unique within the document; `createdAt` is an
 * ISO-8601 timestamp. The geometry backend never reads this block — it must
 * never affect builds, exports, or codegen.
 */
export interface SavedNamedView {
    id: string;
    name: string;
    position: CurvePoint;
    target: CurvePoint;
    up: CurvePoint;
    createdAt: string;
}

/** One measured coil-to-coil intersection in a W7-X coil-count study report. */
export interface W7xCoilCoilOverlap {
    readonly a: string;
    readonly b: string;
    readonly volumeM3: number;
}

/** One measured coil-to-shell intersection in a W7-X coil-count study report. */
export interface W7xCoilShellOverlap {
    readonly coil: string;
    readonly shell: string;
    readonly volumeM3: number;
}

/**
 * Measured interference/gap report for one candidate W7-X module count.
 *
 * The numbers come from the pinned STEP asset for the matching module count;
 * `summary` is the user-facing sentence shown in the design-study banner.
 */
export interface W7xCoilStudyReport {
    readonly moduleCount: 4 | 5 | 6;
    readonly valid: boolean;
    readonly pitchDeg: number;
    readonly moduleSpanDeg: number;
    readonly uncoveredSectorDeg: number;
    readonly moduleOverlapDeg: number;
    readonly minCoilClearanceM?: number;
    readonly coilCoilOverlaps: readonly W7xCoilCoilOverlap[];
    readonly coilShellOverlaps: readonly W7xCoilShellOverlap[];
    readonly summary: string;
}

/**
 * Additive v3 design-study marker (no migration): an explicitly experimental
 * W7-X coil-count layout. Presence means the document is not simulation-ready;
 * the Python backend still serves display builds but rejects DAGMC/FEM mesh
 * export. Absent means a normal document.
 */
export interface W7xCoilStudy {
    readonly kind: 'w7x-coil-study';
    readonly report: W7xCoilStudyReport;
}

/**
 * Display/report metadata for the native-coil shape study.
 *
 * These are ten editable `coilSweep` bodies replicated across the five valid
 * W7-X modules (50 instances), approximating the reference B-reps. The
 * reference volume is the summed reference STEP coil volume for one module;
 * `summary` is the user-facing sentence shown in the design-study banner.
 */
export interface W7xCoilShapeStudyReport {
    readonly moduleCount: 5;
    readonly coilCount: 50;
    readonly bodyCount: 10;
    readonly sectionWidthM: number;
    readonly sectionHeightM: number;
    readonly sectionTiltDeg: number;
    readonly twistDeg: number;
    readonly stations: number;
    readonly referenceVolumeM3: number;
    readonly summary: string;
}

/**
 * Additive v3 design-study marker (no migration): the self-contained native
 * coil shape study. Presence means the document is not simulation-ready; the
 * Python backend still serves display builds but rejects DAGMC/FEM mesh
 * export. Absent means a normal document.
 */
export interface W7xCoilShapeStudy {
    readonly kind: 'w7x-coil-shape-study';
    readonly report: W7xCoilShapeStudyReport;
}

/** Union of the explicitly experimental W7-X design-study markers. */
export type W7xDesignStudy = W7xCoilStudy | W7xCoilShapeStudy;

/** Complete `.nuke-cad` document. */
export interface NukeCadDocument {
    version: number;
    name: string;
    /**
     * Declared length unit for curve-expression coercion and dimension display.
     * Absent means legacy unitless (unit syntax stays rejected, no suffix shown).
     */
    units?: DocumentUnits;
    /**
     * Optional display-only faceting tolerance override. Large demo documents
     * use a coarser value to keep the tessellation under the frontend read
     * budget; exports and FEM meshing keep their own tolerance preferences.
     * Absent means the normal `nukeCad.displayFacetingTolerance` path.
     */
    displayTolerance?: number;
    /**
     * Optional overlap-warning gate for a known-valid large assembly.
     *
     * Absent means `true`: cross-body and assembly-instance overlap checks run
     * and report warnings. `false` skips both exact-boolean O(n²) passes for a
     * validated layout (for example the 15-body/55-instance W7-X generator),
     * where those checks dominate the build and the contacts are intentional.
     * This is an author assertion about the model, not a display preference:
     * geometry, selector maps, and codegen are unchanged, and DAGMC export
     * keeps its own overlap gate.
     */
    overlapCheck?: boolean;
    parameters: Record<string, number>;
    datums: DatumPlane[];
    bodies: BodyDef[];
    sketches: SketchDef[];
    features: FeatureDef[];
    curves: CurveDef[];
    /**
     * Additive assembly section (schema v3). Absent — or present with an
     * empty `groundedInstanceId` — means a single-part document.
     */
    assembly?: NukeCadAssembly;
    /**
     * Additive drawing sheets (schema v3). Absent means the document
     * has no drawings. Drawing output is derived, never cached in the zip, so
     * no migration step exists: older documents simply have no `drawings`.
     */
    drawings?: DrawingSheet[];
    /**
     * Additive pinned viewport measurements (schema v3). Absent means the
     * document has no saved measurements. The backend never reads this
     * block: older documents simply have no `measurements`, and no migration
     * step exists.
     */
    measurements?: SavedMeasurement[];
    /**
     * Additive saved viewport cameras (schema v3). Absent means the document
     * has no named views. Display-only state: the backend never reads this
     * block, so older documents simply have no `views` and no migration step
     * exists.
     */
    views?: SavedNamedView[];
    /**
     * Additive design-study marker (schema v3). Present means the document is
     * an explicitly experimental W7-X layout (coil-count or native shape
     * study): display builds work, but the geometry backend rejects DAGMC/FEM
     * mesh export. Absent means a normal document; no migration step exists and
     * `cloneDocument` preserves the block.
     */
    designStudy?: W7xDesignStudy;
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
    const kinds: DatumKind[] = ['XY', 'YZ', 'XZ', 'offset', 'face', 'threePoint', 'midplane', 'line2Point'];
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
    if (datum.kind === 'threePoint') {
        validateDatumPoints(ctx, `${path}.points`, datum.points, 3);
        if (Array.isArray(datum.points) && datum.points.length === 3 && datum.points.every(isFinitePoint3)) {
            const [a, b, c] = datum.points as CurvePoint[];
            if (triangleArea(a, b, c) <= THREE_POINT_COLLINEAR_AREA) {
                issue(ctx, `${path}.points`, 'threePoint datum points must not be collinear');
            }
        }
    }
    if (datum.kind === 'midplane') {
        if (!Array.isArray(datum.faces) || datum.faces.length !== 2) {
            issue(ctx, `${path}.faces`, 'midplane datum requires exactly 2 face references');
        } else {
            for (const [i, face] of datum.faces.entries()) {
                validateEmbeddedTopologyRef(ctx, `${path}.faces[${i}]`, face);
            }
        }
    }
    if (datum.kind === 'line2Point') {
        validateDatumPoints(ctx, `${path}.points`, datum.points, 2);
        if (Array.isArray(datum.points) && datum.points.length === 2 && datum.points.every(isFinitePoint3)) {
            const [a, b] = datum.points as CurvePoint[];
            if (pointDistance(a, b) <= LINE_DATUM_COINCIDENT_DISTANCE) {
                issue(ctx, `${path}.points`, 'line2Point datum points must be distinct');
            }
        }
    }
}

/** Absolute triangle-area threshold below which three datum points count as collinear. */
const THREE_POINT_COLLINEAR_AREA = 1e-9;

/** Absolute distance threshold below which two line-datum points count as coincident. */
const LINE_DATUM_COINCIDENT_DISTANCE = 1e-9;

function isFinitePoint3(value: unknown): value is CurvePoint {
    return Array.isArray(value) && value.length === 3 && value.every((v: unknown) => isFiniteNumber(v));
}

function validateDatumPoints(ctx: MutableValidationContext, path: string, points: unknown, expected: number): void {
    if (!Array.isArray(points) || points.length !== expected) {
        issue(ctx, path, `datum requires exactly ${expected} points`);
        return;
    }
    for (const [i, point] of points.entries()) {
        if (!isFinitePoint3(point)) {
            issue(ctx, `${path}[${i}]`, 'datum point must be a [x, y, z] tuple of finite numbers');
        }
    }
}

function triangleArea(a: CurvePoint, b: CurvePoint, c: CurvePoint): number {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    return Math.sqrt(cross[0] * cross[0] + cross[1] * cross[1] + cross[2] * cross[2]) / 2;
}

function pointDistance(a: CurvePoint, b: CurvePoint): number {
    return Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2 + (b[2] - a[2]) ** 2);
}

function validateBodyAppearance(ctx: MutableValidationContext, path: string, appearance: unknown): void {
    if (!isPlainObject(appearance)) {
        issue(ctx, path, 'appearance must be an object');
        return;
    }
    const { color, opacity } = appearance as BodyAppearance;
    if (color === undefined && opacity === undefined) {
        issue(ctx, path, 'appearance must set color, opacity, or both');
    }
    if (color !== undefined) {
        if (!isString(color) || !/^#[0-9a-fA-F]{6}$/.test(color)) {
            issue(ctx, `${path}.color`, 'color must be a #rrggbb hex string');
        }
    }
    if (opacity !== undefined) {
        if (!isFiniteNumber(opacity) || opacity < 0 || opacity > 1) {
            issue(ctx, `${path}.opacity`, 'opacity must be a finite number between 0 and 1');
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
    if (body.material !== undefined) {
        if (!isString(body.material)) {
            issue(ctx, `${path}.material`, 'material must be a string when present');
        } else if (body.material.trim().length === 0) {
            issue(ctx, `${path}.material`, 'material must be a non-empty string when present');
        } else {
            const reason = validateBodyMaterialTag(body.material);
            if (reason !== undefined) {
                issue(ctx, `${path}.material`, reason);
            }
        }
    }
    if (body.appearance !== undefined) {
        validateBodyAppearance(ctx, `${path}.appearance`, body.appearance);
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
        'coilSweep',
        'fillet',
        'chamfer',
        'draft',
        'shell',
        'mirror',
        'linearPattern',
        'circularPattern',
        'lattice',
        'booleanFuse',
        'booleanCut',
        'booleanCommon',
        'hole',
        'primitive',
        'multiTransform',
        'defeature',
        'translate',
        'import'
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

function validatePatternScale(ctx: MutableValidationContext, path: string, p: Record<string, unknown>): void {
    if (p.scale !== undefined && (!isFiniteNumber(p.scale) || (p.scale as number) <= 0)) {
        issue(ctx, `${path}.scale`, 'scale must be a positive finite number when present');
    }
}

/** Lowercase SHA-256 hex digest, the only form accepted for `sourceHash`. */
export const IMPORT_SOURCE_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** Validate an import selection: all solids, or a unique non-empty solid list. */
function validateImportSelection(ctx: MutableValidationContext, path: string, selection: unknown): void {
    if (!isPlainObject(selection)) {
        issue(ctx, path, 'selection must be an object');
        return;
    }
    const mode = selection.mode;
    if (mode === 'all') {
        return;
    }
    if (mode !== 'solids') {
        issue(ctx, `${path}.mode`, "selection mode must be 'all' or 'solids'");
        return;
    }
    const solids = selection.solids;
    if (!Array.isArray(solids) || solids.length === 0) {
        issue(ctx, `${path}.solids`, "selection mode 'solids' requires a non-empty array of solid picks");
        return;
    }
    const seen = new Set<number>();
    for (const [i, pick] of solids.entries()) {
        const pickPath = `${path}.solids[${i}]`;
        if (!isPlainObject(pick)) {
            issue(ctx, pickPath, 'solid pick must be an object');
            continue;
        }
        const index = pick.index;
        if (!Number.isInteger(index) || (index as number) < 1) {
            issue(ctx, `${pickPath}.index`, 'solid index must be a positive integer (1-based)');
        } else if (seen.has(index as number)) {
            issue(ctx, `${pickPath}.index`, `duplicate solid index ${index}`);
        } else {
            seen.add(index as number);
        }
        if (pick.signature !== undefined) {
            if (!isPlainObject(pick.signature)) {
                issue(ctx, `${pickPath}.signature`, 'signature must be an object when present');
            } else {
                const signature = pick.signature;
                if (!Number.isInteger(signature.faceCount) || (signature.faceCount as number) < 1) {
                    issue(ctx, `${pickPath}.signature.faceCount`, 'faceCount must be a positive integer');
                }
                if (!isFiniteNumber(signature.volume)) {
                    issue(ctx, `${pickPath}.signature.volume`, 'volume must be a finite number');
                }
            }
        }
    }
}

/** Validate an import placement: each present field is a finite 3-tuple. */
function validateImportPlacement(ctx: MutableValidationContext, path: string, placement: unknown): void {
    if (!isPlainObject(placement)) {
        issue(ctx, path, 'placement must be an object when present');
        return;
    }
    for (const key of ['translate', 'rotateDegrees'] as const) {
        const vector = placement[key];
        if (vector !== undefined && !isFinitePoint3(vector)) {
            issue(ctx, `${path}.${key}`, `${key} must be a [x, y, z] tuple of finite numbers`);
        }
    }
}

function validateFeatureParams(ctx: MutableValidationContext, path: string, type: FeatureType, params: FeatureParams): void {
    const p = params as Record<string, unknown>;
    switch (type) {
        case 'pad':
        case 'pocket': {
            const ends = ['blind', 'upToFirst', 'upToLast', 'upToFace', 'throughAll'];
            if (p.end !== undefined && !ends.includes(p.end as string)) {
                issue(ctx, `${path}.end`, `unknown extrude end '${p.end}'`);
            }
            const end = p.end === undefined || !ends.includes(p.end as string) ? 'blind' : (p.end as string);
            if (end === 'blind') {
                if (!isFiniteNumber(p.length) || (p.length as number) <= 0) {
                    issue(ctx, `${path}.length`, 'length is required and must be a positive finite number');
                }
            } else if (p.length !== undefined) {
                issue(ctx, `${path}.length`, `length must be omitted for '${end}' ends`);
            }
            if (p.symmetric === true && end !== 'blind') {
                issue(ctx, `${path}.symmetric`, `symmetric requires a blind end (got '${end}')`);
            }
            if (p.twoSided !== undefined && typeof p.twoSided !== 'boolean') {
                issue(ctx, `${path}.twoSided`, 'twoSided must be a boolean when present');
            }
            if (p.angle !== undefined && (!isFiniteNumber(p.angle) || (p.angle as number) < -360 || (p.angle as number) > 360)) {
                issue(ctx, `${path}.angle`, 'draft angle must be between -360 and 360 degrees');
            }
            if (p.upToFace !== undefined) {
                validateEmbeddedTopologyRef(ctx, `${path}.upToFace`, p.upToFace);
            }
            if (end === 'upToFace' && p.upToFace === undefined) {
                issue(ctx, `${path}.upToFace`, 'upToFace end requires an upToFace reference');
            }
            if (p.upToBody !== undefined && (!isString(p.upToBody) || p.upToBody.length === 0)) {
                issue(ctx, `${path}.upToBody`, 'upToBody must be a non-empty body id when present');
            }
            if (p.upToBody !== undefined && p.upToFace !== undefined) {
                issue(ctx, `${path}.upToBody`, 'upToBody and upToFace are mutually exclusive');
            }
            break;
        }
        case 'revolve':
        case 'groove': {
            const axis = p.axis;
            if (axis !== 'x' && axis !== 'y' && axis !== 'z') {
                issue(ctx, `${path}.axis`, "axis must be 'x', 'y' or 'z'");
            }
            if (!isFiniteNumber(p.angle) || p.angle <= 0 || p.angle > 360) {
                issue(ctx, `${path}.angle`, 'revolve angle is required and must be in (0, 360] degrees');
            }
            const revolveEnds = ['blind', 'throughAll'];
            if (p.end !== undefined && !revolveEnds.includes(p.end as string)) {
                issue(ctx, `${path}.end`, `unknown revolve end '${p.end}'`);
            }
            break;
        }
        case 'sweep':
            if (!isString(p.pathCurveId) || p.pathCurveId.length === 0) {
                issue(ctx, `${path}.pathCurveId`, 'pathCurveId is required and must be a non-empty string');
            }
            validateSweepOrientation(ctx, path, p);
            break;
        case 'coilSweep': {
            if (!isString(p.pathCurveId) || p.pathCurveId.length === 0) {
                issue(ctx, `${path}.pathCurveId`, 'pathCurveId is required and must be a non-empty string');
            }
            for (const name of ['width', 'height'] as const) {
                if (!isFiniteNumber(p[name]) || (p[name] as number) <= 0) {
                    issue(ctx, `${path}.${name}`, `${name} is required and must be a positive finite number`);
                }
            }
            if (p.tiltDeg !== undefined && (!isFiniteNumber(p.tiltDeg) || p.tiltDeg < -89 || p.tiltDeg > 89)) {
                issue(ctx, `${path}.tiltDeg`, 'tiltDeg must be a finite number in [-89, 89] degrees when present');
            }
            if (p.twistDeg !== undefined && !isFiniteNumber(p.twistDeg)) {
                issue(ctx, `${path}.twistDeg`, 'twistDeg must be a finite number when present');
            }
            if (p.stations !== undefined && (!Number.isInteger(p.stations) || (p.stations as number) < 8 || (p.stations as number) > 720)) {
                issue(ctx, `${path}.stations`, 'stations must be an integer in [8, 720] when present');
            }
            break;
        }
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
            if (p.subtractive !== undefined && typeof p.subtractive !== 'boolean') {
                issue(ctx, `${path}.subtractive`, 'subtractive must be a boolean when present');
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
            if (p.neutralPlane !== undefined) {
                if (!isPlainObject(p.neutralPlane)) {
                    issue(ctx, `${path}.neutralPlane`, 'neutralPlane must be a TopologyRef when present');
                } else {
                    validateEmbeddedTopologyRef(ctx, `${path}.neutralPlane`, p.neutralPlane);
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
            const hasLinearAxis = p.axis === 'x' || p.axis === 'y' || p.axis === 'z';
            const hasLinearAxisDatum = isString(p.axisDatumId) && p.axisDatumId.length > 0;
            if (!hasLinearAxis && !hasLinearAxisDatum) {
                issue(ctx, `${path}.axis`, "linear pattern requires axis 'x'/'y'/'z' or axisDatumId");
            }
            if (hasLinearAxis && hasLinearAxisDatum) {
                issue(ctx, `${path}.axis`, 'axis and axisDatumId are mutually exclusive');
            }
            validatePatternScale(ctx, path, p);
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
            validatePatternScale(ctx, path, p);
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
            validatePatternScale(ctx, path, p);
            break;
        }
        case 'lattice': {
            if (!isString(p.source) || p.source.length === 0) {
                issue(ctx, `${path}.source`, 'source is required and must be a feature id');
            }
            if (p.latticeType !== 'rectangular' && p.latticeType !== 'hexagonal') {
                issue(ctx, `${path}.latticeType`, "latticeType must be 'rectangular' or 'hexagonal'");
            }
            const hasGrid = p.rows !== undefined || p.cols !== undefined;
            const hasRings = p.rings !== undefined;
            if (hasGrid && hasRings) {
                issue(ctx, `${path}.rings`, 'rows/cols and rings are mutually exclusive');
            } else if (hasGrid) {
                if (p.rows === undefined || p.cols === undefined) {
                    issue(ctx, `${path}.rows`, 'rows and cols are required together');
                } else {
                    if (!Number.isInteger(p.rows) || (p.rows as number) < 1) {
                        issue(ctx, `${path}.rows`, 'rows must be an integer >= 1');
                    }
                    if (!Number.isInteger(p.cols) || (p.cols as number) < 1) {
                        issue(ctx, `${path}.cols`, 'cols must be an integer >= 1');
                    }
                }
            } else if (hasRings) {
                if (!Number.isInteger(p.rings) || (p.rings as number) < 0) {
                    issue(ctx, `${path}.rings`, 'rings must be an integer >= 0');
                }
            } else {
                issue(ctx, `${path}.rows`, 'lattice requires rows/cols or rings');
            }
            if (!isFiniteNumber(p.pitch) || (p.pitch as number) <= 0) {
                issue(ctx, `${path}.pitch`, 'pitch must be a positive finite number');
            }
            if (p.pitchY !== undefined) {
                if (p.latticeType !== 'rectangular') {
                    issue(ctx, `${path}.pitchY`, 'pitchY is only valid for rectangular lattices');
                } else if (!isFiniteNumber(p.pitchY) || (p.pitchY as number) <= 0) {
                    issue(ctx, `${path}.pitchY`, 'pitchY must be a positive finite number');
                }
            }
            if (p.orientation !== undefined) {
                if (p.latticeType !== 'hexagonal') {
                    issue(ctx, `${path}.orientation`, 'orientation is only valid for hexagonal lattices');
                } else if (p.orientation !== 'flatTop' && p.orientation !== 'pointyTop') {
                    issue(ctx, `${path}.orientation`, "orientation must be 'flatTop' or 'pointyTop'");
                }
            }
            if (p.datumId !== undefined && (!isString(p.datumId) || p.datumId.length === 0)) {
                issue(ctx, `${path}.datumId`, 'datumId must be a non-empty string when present');
            }
            if (p.origin !== undefined) {
                const origin = p.origin;
                if (!Array.isArray(origin) || origin.length !== 2 || !origin.every((v: unknown) => isFiniteNumber(v))) {
                    issue(ctx, `${path}.origin`, 'origin must be a [x, y] pair of finite numbers');
                }
            }
            if (p.labelPrefix !== undefined && (!isString(p.labelPrefix) || p.labelPrefix.length === 0)) {
                issue(ctx, `${path}.labelPrefix`, 'labelPrefix must be a non-empty string when present');
            }
            const rows = p.rows as number;
            const cols = p.cols as number;
            const rings = p.rings as number;
            let cellCount: number | undefined;
            if (Number.isInteger(rows) && rows >= 1 && Number.isInteger(cols) && cols >= 1) {
                cellCount = rows * cols;
            } else if (Number.isInteger(rings) && rings >= 0) {
                cellCount = 1 + 3 * rings * (rings + 1);
            }
            if (cellCount !== undefined && cellCount > LATTICE_MAX_CELLS) {
                issue(
                    ctx,
                    `${path}.rows`,
                    `lattice has ${cellCount} cells, above the ${LATTICE_MAX_CELLS}-cell limit; build it stepwise (multiple lattice features) instead`
                );
            }
            validatePatternScale(ctx, path, p);
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
            const hasCounterdrill = p.counterdrillDiameter !== undefined || p.counterdrillDepth !== undefined;
            if (hasCounterbore && hasCountersink) {
                issue(ctx, `${path}.counterboreDiameter`, 'counterbore and countersink are mutually exclusive');
            }
            if (hasCounterdrill && (hasCounterbore || hasCountersink)) {
                issue(ctx, `${path}.counterdrillDiameter`, 'counterdrill is mutually exclusive with counterbore/countersink');
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
            if (hasCounterdrill) {
                if (!isFiniteNumber(p.counterdrillDiameter) || (p.counterdrillDiameter as number) <= 0) {
                    issue(ctx, `${path}.counterdrillDiameter`, 'counterdrillDiameter must be positive');
                }
                if (!isFiniteNumber(p.counterdrillDepth) || (p.counterdrillDepth as number) <= 0) {
                    issue(ctx, `${path}.counterdrillDepth`, 'counterdrillDepth must be positive');
                }
            }
            if (
                p.taperAngle !== undefined &&
                (!isFiniteNumber(p.taperAngle) || (p.taperAngle as number) <= 0 || (p.taperAngle as number) > 45)
            ) {
                issue(ctx, `${path}.taperAngle`, 'taperAngle must be in (0, 45] degrees');
            }
            if (
                p.drillPointAngle !== undefined &&
                (!isFiniteNumber(p.drillPointAngle) || (p.drillPointAngle as number) <= 0 || (p.drillPointAngle as number) >= 180)
            ) {
                issue(ctx, `${path}.drillPointAngle`, 'drillPointAngle must be in (0, 180) degrees');
            }
            if (p.thread !== undefined && p.thread !== 'none' && p.thread !== 'cosmetic' && p.thread !== 'modeled') {
                issue(ctx, `${path}.thread`, `unknown hole thread '${p.thread}'`);
            }
            if (p.thread === 'modeled') {
                // Modeled threads sweep the ISO profile as a helical cut: blind
                // simple holes only. Counterbore/countersink/counterdrill and
                // taper combinations hatch backend-side with a clear error, so
                // they are rejected here; through-holes (no depth) cannot thread.
                if (p.depth === undefined) {
                    issue(ctx, `${path}.thread`, 'modeled thread requires a blind hole (depth must be set)');
                }
                if (hasCounterbore || hasCountersink || hasCounterdrill) {
                    issue(
                        ctx,
                        `${path}.thread`,
                        'modeled thread is only supported on simple holes (no counterbore/countersink/counterdrill)'
                    );
                }
                if (p.taperAngle !== undefined) {
                    issue(ctx, `${path}.thread`, 'modeled thread is only supported on simple holes (taperAngle must be omitted)');
                }
            }
            break;
        }
        case 'primitive': {
            const shapes = ['box', 'cylinder', 'sphere', 'cone', 'torus'];
            if (!shapes.includes(p.shape as string)) {
                issue(ctx, `${path}.shape`, `unknown primitive shape '${p.shape}'`);
            }
            const arities: Record<string, number> = { box: 3, cylinder: 2, sphere: 1, cone: 2, torus: 2 };
            const expectedArity = arities[p.shape as string];
            if (!Array.isArray(p.dimensions)) {
                issue(ctx, `${path}.dimensions`, 'primitive requires a dimensions array');
            } else if (expectedArity !== undefined && p.dimensions.length !== expectedArity) {
                issue(ctx, `${path}.dimensions`, `primitive shape '${p.shape}' requires exactly ${expectedArity} dimensions`);
            } else {
                for (const [i, dim] of p.dimensions.entries()) {
                    if (!isFiniteNumber(dim) || (dim as number) <= 0) {
                        issue(ctx, `${path}.dimensions[${i}]`, 'primitive dimensions must be positive finite numbers');
                    }
                }
            }
            if (p.datumId !== undefined && (!isString(p.datumId) || p.datumId.length === 0)) {
                issue(ctx, `${path}.datumId`, 'datumId must be a non-empty string when present');
            }
            if (p.subtractive !== undefined && typeof p.subtractive !== 'boolean') {
                issue(ctx, `${path}.subtractive`, 'subtractive must be a boolean when present');
            }
            break;
        }
        case 'multiTransform': {
            for (const key of ['first', 'second'] as const) {
                if (!isString(p[key]) || (p[key] as string).length === 0) {
                    issue(ctx, `${path}.${key}`, `${key} is required and must be a pattern/mirror feature id`);
                }
            }
            break;
        }
        case 'defeature': {
            if (!Array.isArray(p.faces) || p.faces.length === 0) {
                issue(ctx, `${path}.faces`, 'faces must be a non-empty array of TopologyRefs');
            } else {
                for (const [i, face] of p.faces.entries()) {
                    validateEmbeddedTopologyRef(ctx, `${path}.faces[${i}]`, face);
                }
            }
            break;
        }
        case 'translate': {
            const vector = p.vector;
            if (!Array.isArray(vector) || vector.length !== 3 || !vector.every((v: unknown) => isFiniteNumber(v))) {
                issue(ctx, `${path}.vector`, 'vector must be a [dx, dy, dz] tuple of finite numbers');
            } else if (vector[0] === 0 && vector[1] === 0 && vector[2] === 0) {
                issue(ctx, `${path}.vector`, 'vector must be non-zero');
            }
            break;
        }
        case 'import': {
            if (!isString(p.sourcePath) || p.sourcePath.length === 0) {
                issue(ctx, `${path}.sourcePath`, 'sourcePath is required and must be a non-empty string');
            }
            if (!isString(p.sourceHash) || !IMPORT_SOURCE_HASH_PATTERN.test(p.sourceHash)) {
                issue(ctx, `${path}.sourceHash`, 'sourceHash must be a lowercase SHA-256 hex digest');
            }
            if (p.sourceSize !== undefined && (!Number.isInteger(p.sourceSize) || (p.sourceSize as number) < 1)) {
                issue(ctx, `${path}.sourceSize`, 'sourceSize must be a positive integer when present');
            }
            if (p.sourceFormat !== undefined && !IMPORT_SOURCE_FORMATS.includes(p.sourceFormat as ImportSourceFormat)) {
                issue(ctx, `${path}.sourceFormat`, `unknown import source format '${p.sourceFormat}' (expected step, iges or brep)`);
            }
            if (p.sourceUnit !== undefined && !IMPORT_SOURCE_UNITS.includes(p.sourceUnit as ImportSourceUnit)) {
                issue(ctx, `${path}.sourceUnit`, `unknown import source unit '${p.sourceUnit}' (expected mm, cm or m)`);
            }
            if (p.selection === undefined) {
                issue(ctx, `${path}.selection`, 'selection is required');
            } else {
                validateImportSelection(ctx, `${path}.selection`, p.selection);
            }
            if (p.placement !== undefined) {
                validateImportPlacement(ctx, `${path}.placement`, p.placement);
            }
            if (p.maxSolids !== undefined && (!Number.isInteger(p.maxSolids) || (p.maxSolids as number) < 1)) {
                issue(ctx, `${path}.maxSolids`, 'maxSolids must be a positive integer when present');
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
 * Expected point counts per saved-measurement kind: distance carries its two
 * endpoints, angle its A/vertex-B/C triple, radius a center plus a rim point
 * (the radius derives as their distance).
 */
const SAVED_MEASUREMENT_POINT_COUNTS: Record<SavedMeasurementKind, number> = {
    distance: 2,
    angle: 3,
    radius: 2
};

function validateSavedMeasurement(ctx: MutableValidationContext, measurement: SavedMeasurement, index: number): void {
    const path = `measurements[${index}]`;
    requireId(ctx, `${path}.id`, measurement.id);
    const kinds: SavedMeasurementKind[] = ['distance', 'angle', 'radius'];
    if (!kinds.includes(measurement.kind)) {
        issue(ctx, `${path}.kind`, `unknown measurement kind '${measurement.kind}'`);
        return;
    }
    if (!Array.isArray(measurement.points)) {
        issue(ctx, `${path}.points`, 'points must be an array of [x, y, z] tuples in model units');
    } else {
        const expected = SAVED_MEASUREMENT_POINT_COUNTS[measurement.kind];
        if (measurement.points.length !== expected) {
            issue(ctx, `${path}.points`, `measurement kind '${measurement.kind}' requires exactly ${expected} point(s)`);
        }
        for (const [i, point] of measurement.points.entries()) {
            if (!isFinitePoint3(point)) {
                issue(ctx, `${path}.points[${i}]`, 'measurement point must be a [x, y, z] tuple of finite numbers');
            }
        }
    }
    if (!isString(measurement.label)) {
        issue(ctx, `${path}.label`, 'label must be a string');
    }
    if (!isString(measurement.createdAt) || measurement.createdAt.length === 0) {
        issue(ctx, `${path}.createdAt`, 'createdAt must be a non-empty timestamp string');
    }
}

/** ISO-8601 timestamp with an explicit zone (the form `Date#toISOString` emits). */
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isIsoTimestamp(value: unknown): value is string {
    return isString(value) && ISO_TIMESTAMP_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

function validateSavedNamedView(ctx: MutableValidationContext, view: SavedNamedView, index: number): void {
    const path = `views[${index}]`;
    requireId(ctx, `${path}.id`, view.id);
    if (!isString(view.name) || view.name.trim().length === 0) {
        issue(ctx, `${path}.name`, 'name must be a non-empty string');
    }
    for (const field of ['position', 'target', 'up'] as const) {
        if (!isFinitePoint3(view[field])) {
            issue(ctx, `${path}.${field}`, `${field} must be a [x, y, z] tuple of finite numbers`);
        }
    }
    if (!isIsoTimestamp(view.createdAt)) {
        issue(ctx, `${path}.createdAt`, 'createdAt must be an ISO-8601 timestamp string');
    }
}

/** Accepted module counts for the experimental W7-X coil-count study. */
const W7X_COIL_STUDY_MODULE_COUNTS: readonly number[] = [4, 5, 6];

function validateW7xCoilOverlapEntry(ctx: MutableValidationContext, path: string, entry: unknown, keyA: string, keyB: string): void {
    if (!isPlainObject(entry)) {
        issue(ctx, path, 'overlap entry must be an object');
        return;
    }
    for (const key of [keyA, keyB]) {
        const value = entry[key];
        if (!isString(value) || value.trim().length === 0) {
            issue(ctx, `${path}.${key}`, `${key} must be a non-empty string`);
        }
    }
    if (!isFiniteNumber(entry.volumeM3)) {
        issue(ctx, `${path}.volumeM3`, 'volumeM3 must be a finite number');
    }
}

function validateW7xCoilStudyReport(ctx: MutableValidationContext, path: string, report: unknown): void {
    if (!isPlainObject(report)) {
        issue(ctx, path, 'report must be an object');
        return;
    }
    if (typeof report.moduleCount !== 'number' || !W7X_COIL_STUDY_MODULE_COUNTS.includes(report.moduleCount)) {
        issue(ctx, `${path}.moduleCount`, 'moduleCount must be 4, 5, or 6');
    }
    if (typeof report.valid !== 'boolean') {
        issue(ctx, `${path}.valid`, 'valid must be a boolean');
    }
    for (const field of ['pitchDeg', 'moduleSpanDeg', 'uncoveredSectorDeg', 'moduleOverlapDeg'] as const) {
        if (!isFiniteNumber(report[field])) {
            issue(ctx, `${path}.${field}`, `${field} must be a finite number`);
        }
    }
    if (report.minCoilClearanceM !== undefined && !isFiniteNumber(report.minCoilClearanceM)) {
        issue(ctx, `${path}.minCoilClearanceM`, 'minCoilClearanceM must be a finite number when present');
    }
    if (!Array.isArray(report.coilCoilOverlaps)) {
        issue(ctx, `${path}.coilCoilOverlaps`, 'coilCoilOverlaps must be an array');
    } else {
        for (const [i, entry] of report.coilCoilOverlaps.entries()) {
            validateW7xCoilOverlapEntry(ctx, `${path}.coilCoilOverlaps[${i}]`, entry, 'a', 'b');
        }
    }
    if (!Array.isArray(report.coilShellOverlaps)) {
        issue(ctx, `${path}.coilShellOverlaps`, 'coilShellOverlaps must be an array');
    } else {
        for (const [i, entry] of report.coilShellOverlaps.entries()) {
            validateW7xCoilOverlapEntry(ctx, `${path}.coilShellOverlaps[${i}]`, entry, 'coil', 'shell');
        }
    }
    if (!isString(report.summary) || report.summary.trim().length === 0) {
        issue(ctx, `${path}.summary`, 'summary must be a non-empty string');
    }
}

function validateW7xCoilShapeStudyReport(ctx: MutableValidationContext, path: string, report: unknown): void {
    if (!isPlainObject(report)) {
        issue(ctx, path, 'report must be an object');
        return;
    }
    if (report.moduleCount !== 5) {
        issue(ctx, `${path}.moduleCount`, 'moduleCount must be exactly 5');
    }
    if (report.coilCount !== 50) {
        issue(ctx, `${path}.coilCount`, 'coilCount must be exactly 50');
    }
    if (report.bodyCount !== 10) {
        issue(ctx, `${path}.bodyCount`, 'bodyCount must be exactly 10');
    }
    for (const field of ['sectionWidthM', 'sectionHeightM', 'referenceVolumeM3'] as const) {
        if (!isFiniteNumber(report[field]) || report[field] <= 0) {
            issue(ctx, `${path}.${field}`, `${field} must be a positive finite number`);
        }
    }
    for (const field of ['sectionTiltDeg', 'twistDeg'] as const) {
        if (!isFiniteNumber(report[field])) {
            issue(ctx, `${path}.${field}`, `${field} must be a finite number`);
        }
    }
    if (!isFiniteNumber(report.stations) || !Number.isInteger(report.stations) || report.stations < 8 || report.stations > 720) {
        issue(ctx, `${path}.stations`, 'stations must be an integer in [8, 720]');
    }
    if (!isString(report.summary) || report.summary.trim().length === 0) {
        issue(ctx, `${path}.summary`, 'summary must be a non-empty string');
    }
}

function validateW7xCoilStudyValue(ctx: MutableValidationContext, path: string, study: unknown): void {
    if (!isPlainObject(study)) {
        issue(ctx, path, 'designStudy must be an object');
        return;
    }
    if (study.kind !== 'w7x-coil-study') {
        issue(ctx, `${path}.kind`, "kind must be 'w7x-coil-study'");
        return;
    }
    validateW7xCoilStudyReport(ctx, `${path}.report`, study.report);
}

function validateW7xDesignStudyValue(ctx: MutableValidationContext, path: string, study: unknown): void {
    if (!isPlainObject(study)) {
        issue(ctx, path, 'designStudy must be an object');
        return;
    }
    if (study.kind === 'w7x-coil-study') {
        validateW7xCoilStudyReport(ctx, `${path}.report`, study.report);
        return;
    }
    if (study.kind === 'w7x-coil-shape-study') {
        validateW7xCoilShapeStudyReport(ctx, `${path}.report`, study.report);
        return;
    }
    issue(ctx, `${path}.kind`, "kind must be 'w7x-coil-study' or 'w7x-coil-shape-study'");
}

/**
 * Validate a W7-X coil-study block on its own (issue paths use `designStudy`).
 *
 * The store calls this before cloning so a malformed study is a structured
 * error instead of a candidate-document validation failure.
 */
export function validateW7xCoilStudy(study: unknown): ValidationResult {
    const ctx: MutableValidationContext = { issues: [], ids: new Set<string>() };
    validateW7xCoilStudyValue(ctx, 'designStudy', study);
    return { valid: ctx.issues.length === 0, issues: ctx.issues };
}

/** Validate either W7-X design-study marker on its own (issue paths use `designStudy`). */
export function validateW7xDesignStudy(study: unknown): ValidationResult {
    const ctx: MutableValidationContext = { issues: [], ids: new Set<string>() };
    validateW7xDesignStudyValue(ctx, 'designStudy', study);
    return { valid: ctx.issues.length === 0, issues: ctx.issues };
}

/**
 * Validate the additive assembly section by delegating to the frozen
 * `validateAssemblyDocument` spec on a synthesized root. Absent assembly is
 * handled by the caller; an empty `groundedInstanceId` means single-part and
 * skips assembly checks entirely (grounding is explicit, never defaulted).
 */
function validateAssemblySection(ctx: MutableValidationContext, assembly: unknown): void {
    if (!isPlainObject(assembly)) {
        issue(ctx, 'assembly', 'assembly must be an object');
        return;
    }
    const section = assembly as unknown as NukeCadAssembly;
    if (section.groundedInstanceId === '') {
        return;
    }
    const result = validateAssemblyDocument({
        version: ASSEMBLY_SCHEMA_VERSION,
        name: 'assembly',
        instances: Array.isArray(section.instances) ? section.instances : [],
        connectors: Array.isArray(section.connectors) ? section.connectors : [],
        mates: Array.isArray(section.mates) ? section.mates : [],
        groundedInstanceId: typeof section.groundedInstanceId === 'string' ? section.groundedInstanceId : ''
    });
    for (const sub of result.issues) {
        issue(ctx, sub.path === '' ? 'assembly' : `assembly.${sub.path}`, sub.message);
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
    if (doc.units !== undefined && doc.units !== 'mm' && doc.units !== 'cm' && doc.units !== 'm') {
        issue(ctx, 'units', `unknown document units '${doc.units}' (expected 'mm', 'cm' or 'm')`);
    }
    if (doc.displayTolerance !== undefined && (!isFiniteNumber(doc.displayTolerance) || doc.displayTolerance <= 0)) {
        issue(ctx, 'displayTolerance', 'displayTolerance must be a positive finite number when present');
    }
    if (doc.overlapCheck !== undefined && typeof doc.overlapCheck !== 'boolean') {
        issue(ctx, 'overlapCheck', 'overlapCheck must be a boolean when present');
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
    if (doc.assembly !== undefined) {
        validateAssemblySection(ctx, doc.assembly);
    }
    if (doc.drawings !== undefined) {
        if (!Array.isArray(doc.drawings)) {
            issue(ctx, 'drawings', 'drawings must be an array of drawing sheets');
        } else {
            for (const [i, sheet] of doc.drawings.entries()) {
                const sink: DrawingValidationSink = {
                    issue: (path, message) => issue(ctx, path, message),
                    claimId: (path, id) => {
                        requireId(ctx, path, id);
                    }
                };
                validateDrawingSheet(sheet, `drawings[${i}]`, sink);
            }
        }
    }
    if (doc.measurements !== undefined) {
        if (!Array.isArray(doc.measurements)) {
            issue(ctx, 'measurements', 'measurements must be an array of saved measurements');
        } else {
            for (const [i, measurement] of doc.measurements.entries()) {
                validateSavedMeasurement(ctx, measurement as SavedMeasurement, i);
            }
        }
    }
    if (doc.views !== undefined) {
        if (!Array.isArray(doc.views)) {
            issue(ctx, 'views', 'views must be an array of saved named views');
        } else {
            const names = new Set<string>();
            for (const [i, view] of doc.views.entries()) {
                validateSavedNamedView(ctx, view as SavedNamedView, i);
                const name = (view as SavedNamedView).name;
                if (isString(name) && name.trim().length > 0) {
                    const key = name.trim().toLowerCase();
                    if (names.has(key)) {
                        issue(ctx, `views[${i}].name`, `duplicate view name '${name.trim()}'`);
                    }
                    names.add(key);
                }
            }
        }
    }
    if (doc.designStudy !== undefined) {
        validateW7xDesignStudyValue(ctx, 'designStudy', doc.designStudy);
    }

    // Dangling reference pass.
    const datumIds = new Set<string>(doc.datums?.map((d) => (d as DatumPlane).id).filter(isString) ?? []);
    const datumById = new Map<string, DatumPlane>((doc.datums ?? []).map((d) => [(d as DatumPlane).id, d as DatumPlane]));
    const bodyIds = new Set<string>(doc.bodies?.map((b) => (b as BodyDef).id).filter(isString) ?? []);
    const sketchIds = new Set<string>(doc.sketches?.map((s) => (s as SketchDef).id).filter(isString) ?? []);
    const featureIds = new Set<string>(doc.features?.map((f) => (f as FeatureDef).id).filter(isString) ?? []);
    const curveIds = new Set<string>((Array.isArray(doc.curves) ? doc.curves : []).map((c) => (c as CurveDef).id).filter(isString));

    for (const [i, sketch] of (doc.sketches ?? []).entries()) {
        const s = sketch as SketchDef;
        if (s.datumId && !datumIds.has(s.datumId)) {
            issue(ctx, `sketches[${i}].datumId`, `unknown datum '${s.datumId}'`);
        } else if (s.datumId && datumById.get(s.datumId)?.kind === 'line2Point') {
            issue(ctx, `sketches[${i}].datumId`, `datum '${s.datumId}' is a line datum and cannot place a sketch`);
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
        if (f.type === 'linearPattern' || f.type === 'circularPattern' || f.type === 'mirror' || f.type === 'lattice') {
            const p = f.params as Record<string, unknown>;
            if (isString(p.source) && !featureIds.has(p.source)) {
                issue(ctx, `features[${i}].params.source`, `unknown feature '${p.source}'`);
            }
        }
        if (f.type === 'lattice') {
            const p = f.params as Record<string, unknown>;
            if (isString(p.datumId) && p.datumId.length > 0 && !datumIds.has(p.datumId)) {
                issue(ctx, `features[${i}].params.datumId`, `unknown datum '${p.datumId}'`);
            } else if (isString(p.datumId) && p.datumId.length > 0 && datumById.get(p.datumId)?.kind === 'line2Point') {
                issue(ctx, `features[${i}].params.datumId`, `datum '${p.datumId}' is a line datum and cannot place a lattice`);
            }
        }
        if (f.type === 'circularPattern' || f.type === 'linearPattern') {
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
        if (f.type === 'sweep' || f.type === 'pipe' || f.type === 'coilSweep') {
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
        if (f.type === 'pad' || f.type === 'pocket') {
            const p = f.params as Record<string, unknown>;
            if (isString(p.upToBody) && p.upToBody.length > 0 && !bodyIds.has(p.upToBody)) {
                issue(ctx, `features[${i}].params.upToBody`, `unknown body '${p.upToBody}'`);
            }
        }
        if (f.type === 'primitive') {
            const p = f.params as Record<string, unknown>;
            if (isString(p.datumId) && p.datumId.length > 0 && !datumIds.has(p.datumId)) {
                issue(ctx, `features[${i}].params.datumId`, `unknown datum '${p.datumId}'`);
            }
        }
        if (f.type === 'multiTransform') {
            const p = f.params as Record<string, unknown>;
            for (const key of ['first', 'second'] as const) {
                if (isString(p[key]) && !featureIds.has(p[key] as string)) {
                    issue(ctx, `features[${i}].params.${key}`, `unknown feature '${p[key]}'`);
                }
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
