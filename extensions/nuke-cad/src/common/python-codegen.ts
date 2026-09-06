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
 * One-way deterministic export of a `.nuke-cad` document to a build123d-style
 * Python script.
 *
 * This is intentionally not a round-trip: topology-reference-dependent items
 * are emitted as clearly marked ``# TODO(manual):`` comments so the exported
 * script remains readable and no feature is silently dropped.
 *
 * Emission semantics mirror the headless backend (`feature_builder.py` /
 * `sketch_builder.py`):
 *
 * - revolve uses `revolution_arc` (degrees); pattern counts include the
 *   original (instances `1..count-1`); circular patterns step `360/count` for
 *   full sweeps and `angle/(count-1)` for partial sweeps; booleans combine
 *   tool bodies before the operation.
 * - Arcs become `bd.CenterArc` with a signed sweep in degrees (document angles
 *   are radians, CCW-positive).
 * - sweep/pipe reposition their section to the path start via a build123d
 *   `Plane` from the path's start point/tangent; `fixedBinormal` orientation
 *   is emitted with a `# TODO(manual):` comment (build123d cannot lock the
 *   binormal directly). Loft joins its ordered section sketches via
 *   `bd.loft(..., ruled=...)`; helical sweeps derive their path from params
 *   via `bd.Helix(...)` and reuse the sweep emission.
 * - Closed line/arc loops become one face per loop. Profiles are classified
 *   like the backend's outer/inner-wire pairing: sorted by area descending,
 *   a profile whose reference point lies inside an already-accepted outer
 *   profile is a hole and is emitted with `bd.Mode.SUBTRACT`.
 * - Ellipses become `bd.Ellipse(x_radius, y_radius, rotation=deg)` under
 *   `bd.Locations(center)` — same face-emitting pattern as circles.
 * - B-spline segments keep their authored control polygon: `bd.Spline`
 *   interpolates through points and cannot express it, so loops containing a
 *   B-spline are emitted as an explicit `bd.make_face([...])` edge list using
 *   the module-level `_bspline_edge` helper (raw OCP `Geom_BSplineCurve`).
 *   Construction B-splines degrade the sketch to `# TODO(manual):`, as do
 *   periodic or non-unit-weight B-splines (both rejected by the backend).
 * - Assemblies emit an `# Assembly` section when the document is grounded:
 *   per-source instance builds (same-document bodies, `bd.import_step` for
 *   STEP files) plus `resolveMatePlacement`-equivalent placement code
 *   (`_mate_solve`: `R = Ra·RbT`, `t = pa − R·pb`, threaded in
 *   grounded-first BFS order). Reference-dependent mates and unbuildable
 *   sources (`.nuke-cad` paths, per-axis scales) degrade to
 *   `# TODO(manual):`, never faked.
 *
 * @module nuke-cad/common
 */

import { type NukeCadDocument, type SketchDef, type FeatureDef, type DatumPlane, type CurveSource } from './cad-document';
import { instancePlacementToMatrix, type Mat4 } from './assembly-document';
import { FeatureGraph } from './feature-graph';
import { type TopologyRef, type FaceFingerprint, type EdgeFingerprint } from './topology-refs';
import { ellipseAxes, sampleBSplineCurve } from './sketch-curves';

const INDENT = '    ';
const RAD_TO_DEG = 180 / Math.PI;
/** Chord samples per arc when approximating a loop for containment tests. */
const ARC_SAMPLES = 16;

/** Generate a deterministic Python script from the given document. */
export function generatePythonScript(doc: NukeCadDocument): string {
    const lines: string[] = [];
    lines.push(`# Generated from "${doc.name}" by NukeIDE nuke-cad`);
    lines.push('# This is a one-way export; it is NOT re-importable.');
    lines.push('');
    lines.push('import build123d as bd');
    lines.push('');

    if (documentUsesBSpline(doc)) {
        lines.push(...bsplineHelperLines());
        lines.push('');
    }

    if (documentUsesScaledPattern(doc)) {
        lines.push(...scaledPatternHelperLines());
        lines.push('');
    }

    const parameterNames = Object.keys(doc.parameters).sort();
    if (parameterNames.length > 0) {
        lines.push('# Parameters');
        for (const name of parameterNames) {
            const id = sanitizeIdentifier(name);
            lines.push(`${id} = ${formatNumber(doc.parameters[name])}`);
        }
        lines.push('');
    }

    const manualFeatures: string[] = [];
    const datumById = new Map(doc.datums.map((d) => [d.id, d]));

    lines.push('# Datums');
    const datumVarById = new Map<string, string>();
    for (const datum of doc.datums) {
        const varName = sanitizeIdentifier(`datum_${datum.name}_${datum.id}`);
        datumVarById.set(datum.id, varName);
        if (datum.kind === 'XY' || datum.kind === 'YZ' || datum.kind === 'XZ') {
            lines.push(`${varName} = bd.Plane.${datum.kind}  # ${datum.name}`);
        } else if (datum.kind === 'offset') {
            lines.push(`${varName} = bd.Plane.XY.offset(${formatNumber(datum.offset ?? 0)})  # ${datum.name}`);
        } else if (datum.kind === 'face') {
            lines.push(`# TODO(manual): datum "${datum.name}" is a face datum and cannot be exported automatically.`);
            lines.push(`# ${varName} = bd.Plane(...)  # reference: ${summarizeRef(datum.reference)}`);
            manualFeatures.push(`datum "${datum.name}" (face datum)`);
        } else if (datum.kind === 'threePoint' || datum.kind === 'midplane' || datum.kind === 'line2Point') {
            lines.push(`# TODO(manual): datum "${datum.name}" is a ${datum.kind} datum and cannot be exported automatically.`);
            lines.push(`# ${varName} = bd.Plane(...)  # ${summarizeDatumParams(datum)}`);
            manualFeatures.push(`datum "${datum.name}" (${datum.kind} datum)`);
        } else {
            lines.push(`# TODO(manual): datum "${datum.name}" has unknown kind '${datum.kind}' and cannot be exported automatically.`);
            manualFeatures.push(`datum "${datum.name}" (unknown datum kind)`);
        }
    }
    lines.push('');

    lines.push('# Sketches');
    const sketchFuncById = new Map<string, string>();
    const unbuildableSketches = new Set<string>();
    for (const sketch of doc.sketches) {
        const funcName = sanitizeIdentifier(`sketch_${sketch.name}_${sketch.id}`);
        sketchFuncById.set(sketch.id, funcName);
        const emitted = emitSketchFunction(sketch, funcName, datumById, datumVarById);
        if (!emitted.buildable) {
            unbuildableSketches.add(sketch.id);
        }
        lines.push(...emitted.lines);
        lines.push('');
    }

    const orderedFeatures = topologicalFeatureOrder(doc);

    // Curves are emitted before features: sweep/pipe features reference the
    // curve's `bd.Spline` variable as their path, so the variable must be
    // assigned before the feature section runs.
    lines.push('# Curves');
    const curveVarById = new Map<string, string>();
    for (const curve of doc.curves) {
        const varName = uniqueCurveVarName(curve.name, curveVarById);
        curveVarById.set(curve.id, varName);
        const sourceComment = curveSourceComment(curve.source);
        if (sourceComment !== undefined) {
            lines.push(`# ${sourceComment}`);
        }
        const pointsVar = `${varName}_points`;
        lines.push(`${pointsVar} = [${curve.samples.map((p) => tuple(p as [number, number, number])).join(', ')}]`);
        lines.push(`${varName} = bd.Spline(*${pointsVar})  # ${curve.name}`);
        lines.push('');
    }
    if (doc.curves.length === 0) {
        lines.push('# No curves defined.');
        lines.push('');
    }

    lines.push('# Bodies');
    const bodyVarById = new Map<string, string>();
    for (const body of doc.bodies) {
        const varName = uniqueBodyVarName(body.name, bodyVarById);
        bodyVarById.set(body.id, varName);
        const labelComment = body.label !== undefined ? `  # label: ${body.label}` : '';
        lines.push(`${varName} = None  # ${body.name}${labelComment}`);
    }
    lines.push('');

    lines.push('# Features');
    for (const feature of orderedFeatures) {
        if (feature.suppressed) {
            lines.push(`# suppressed: ${feature.type} feature "${feature.name}" (excluded from the build)`);
            continue;
        }
        const emitted = emitFeature(feature, doc, bodyVarById, sketchFuncById, datumVarById, datumById, curveVarById, unbuildableSketches);
        if (emitted === undefined) {
            lines.push(...emitManualTodo(feature));
            manualFeatures.push(`${feature.type} "${feature.name}"`);
        } else {
            lines.push(...emitted);
        }
    }
    lines.push('');

    if (doc.assembly !== undefined && doc.assembly.groundedInstanceId !== '') {
        lines.push(...emitAssemblySection(doc, bodyVarById, manualFeatures));
        lines.push('');
    }

    if (manualFeatures.length > 0) {
        lines.push('# -----------------------------------------------------------------------------');
        lines.push('# Features requiring manual repair before the exported script is runnable');
        lines.push('# -----------------------------------------------------------------------------');
        for (const item of manualFeatures) {
            lines.push(`# TODO(manual): ${item}`);
        }
        lines.push('');
    }

    return lines.join('\n');
}

function formatNumber(value: number): string {
    return JSON.stringify(value);
}

/** True when any sketch carries a non-construction B-spline primitive. */
function documentUsesBSpline(doc: NukeCadDocument): boolean {
    return doc.sketches.some((sketch) =>
        sketch.primitives.some((p) => String(p.type) === 'bspline' && !Boolean(getField(p, 'construction')))
    );
}

/** True when any pattern/mirror feature carries a non-unit scale factor. */
function documentUsesScaledPattern(doc: NukeCadDocument): boolean {
    return doc.features.some((feature) => {
        if (feature.type !== 'linearPattern' && feature.type !== 'circularPattern' && feature.type !== 'mirror') {
            return false;
        }
        const scale = (feature.params as Record<string, unknown>).scale;
        return typeof scale === 'number' && scale !== 1;
    });
}

/**
 * Module-level helper emitted once whenever a pattern/mirror feature scales
 * its instances. `bd.scale` scales about the global origin, so each instance
 * is translated to the origin, scaled, and translated back — a uniform scale
 * about the instance's own bounding-box center, applied after its transform.
 */
function scaledPatternHelperLines(): string[] {
    return [
        'def _scaled_about_center(shape, factor):',
        '    """Uniformly scaled copy of a shape about its own bounding-box center."""',
        '    center = shape.bounding_box().center()',
        '    return bd.scale(shape.moved(bd.Location(center * -1)), factor).moved(bd.Location(center))'
    ];
}

/**
 * Module-level helper emitted once whenever a sketch uses a B-spline edge.
 * `bd.Spline` interpolates through points, so it cannot express control-polygon
 * B-splines; the curve is built from raw OCP objects instead. The helper is a
 * plain function (not a build123d "object"), so generated loops pass its result
 * inside an explicit `bd.make_face([...])` edge list.
 */
function bsplineHelperLines(): string[] {
    return [
        'def _bspline_edge(poles, knots, mults, degree):',
        '    """build123d Edge from a clamped non-periodic B-spline (unit weights)."""',
        '    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge',
        '    from OCP.Geom import Geom_BSplineCurve',
        '    from OCP.gp import gp_Pnt',
        '    from OCP.TColgp import TColgp_Array1OfPnt',
        '    from OCP.TColStd import TColStd_Array1OfInteger, TColStd_Array1OfReal',
        '',
        '    pole_array = TColgp_Array1OfPnt(1, len(poles))',
        '    for index, (x, y) in enumerate(poles, start=1):',
        '        pole_array.SetValue(index, gp_Pnt(x, y, 0))',
        '    knot_array = TColStd_Array1OfReal(1, len(knots))',
        '    for index, value in enumerate(knots, start=1):',
        '        knot_array.SetValue(index, float(value))',
        '    mult_array = TColStd_Array1OfInteger(1, len(mults))',
        '    for index, value in enumerate(mults, start=1):',
        '        mult_array.SetValue(index, int(value))',
        '    curve = Geom_BSplineCurve(pole_array, knot_array, mult_array, int(degree), False)',
        '    return bd.Edge(BRepBuilderAPI_MakeEdge(curve).Edge())'
    ];
}

function sanitizeIdentifier(name: string): string {
    let result = name.replace(/[^a-zA-Z0-9_]+/g, '_');
    if (/^[0-9]/.test(result)) {
        result = `_${result}`;
    }
    if (result.length === 0 || /^_+$/.test(result)) {
        result = 'var';
    }
    return result;
}

function uniqueBodyVarName(name: string, existing: Map<string, string>): string {
    const base = sanitizeIdentifier(`body_${name}`);
    let candidate = base;
    let index = 1;
    const values = new Set(existing.values());
    while (values.has(candidate)) {
        candidate = `${base}_${index++}`;
    }
    return candidate;
}

function summarizeRef(ref: TopologyRef | undefined): string {
    if (ref === undefined) {
        return 'none';
    }
    if (ref.kind === 'face') {
        const fp = ref.fingerprint as FaceFingerprint;
        return `face ${fp.surfaceType} area=${formatNumber(fp.area)} center=${tuple(fp.center)}`;
    }
    const fp = ref.fingerprint as EdgeFingerprint;
    return `edge ${fp.curveType} length=${formatNumber(fp.length)}`;
}

/** One-line summary of a reference-dependent datum's stored parameters. */
function summarizeDatumParams(datum: DatumPlane): string {
    if (datum.kind === 'threePoint' || datum.kind === 'line2Point') {
        const points = Array.isArray(datum.points) ? datum.points.map((p) => tuple(p as [number, number, number])).join(', ') : 'none';
        return `${datum.kind} points: ${points}`;
    }
    if (datum.kind === 'midplane') {
        const faces = Array.isArray(datum.faces) ? datum.faces.map((f) => summarizeRef(f)).join(' | ') : 'none';
        return `midplane faces: ${faces}`;
    }
    return `${datum.kind} datum`;
}

function tuple(point: readonly number[]): string {
    return `(${point.map(formatNumber).join(', ')})`;
}

function getField(obj: Record<string, unknown>, ...names: string[]): unknown {
    for (const name of names) {
        if (name in obj) {
            return obj[name];
        }
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// Sketch emission
// ---------------------------------------------------------------------------

interface SegmentPrim {
    id: string;
    kind: 'line' | 'arc' | 'bspline';
    /** Point id at the start of the segment (arc: at `startAngle`; bspline: first pole). */
    p1: string;
    /** Point id at the end of the segment (arc: at `endAngle`; bspline: last pole). */
    p2: string;
    center?: [number, number];
    radius?: number;
    /** Radians, CCW-positive from the +x axis (planegcs convention). */
    startAngle?: number;
    endAngle?: number;
    /** bspline control polygon in sketch-local coordinates. */
    poles?: [number, number][];
    knots?: number[];
    mult?: number[];
    degree?: number;
}

interface CirclePrim {
    id: string;
    center: [number, number];
    radius: number;
}

/** A full ellipse profile, stored as analytic axes (derived from the planegcs focus form). */
interface EllipsePrim {
    id: string;
    center: [number, number];
    major: number;
    minor: number;
    /** Major-axis rotation from +x, degrees. */
    rotation: number;
}

interface ParsedSketch {
    points: Map<string, [number, number]>;
    segments: SegmentPrim[];
    circles: CirclePrim[];
    ellipses: EllipsePrim[];
    /** Human-readable comment lines for construction primitives. */
    constructionComments: string[];
}

function parseSketchPrimitives(sketch: SketchDef): ParsedSketch | undefined {
    const points = new Map<string, [number, number]>();
    for (const p of sketch.primitives) {
        if (String(p.type) === 'point') {
            const x = Number(getField(p, 'x'));
            const y = Number(getField(p, 'y'));
            if (Number.isFinite(x) && Number.isFinite(y)) {
                points.set(String(p.id), [x, y]);
            }
        }
    }

    const segments: SegmentPrim[] = [];
    const circles: CirclePrim[] = [];
    const ellipses: EllipsePrim[] = [];
    const constructionComments: string[] = [];
    for (const p of sketch.primitives) {
        const id = String(p.id);
        const type = String(p.type);
        const construction = Boolean(getField(p, 'construction'));
        if (type === 'line') {
            const p1 = String(getField(p, 'p1_id', 'p1Id'));
            const p2 = String(getField(p, 'p2_id', 'p2Id'));
            const c1 = points.get(p1);
            const c2 = points.get(p2);
            if (c1 === undefined || c2 === undefined) {
                return undefined;
            }
            if (construction) {
                constructionComments.push(`# construction line ${tuple(c1)} -> ${tuple(c2)}`);
            } else {
                segments.push({ id, kind: 'line', p1, p2 });
            }
        } else if (type === 'circle') {
            const center = points.get(String(getField(p, 'c_id', 'centerId')));
            const radius = Number(getField(p, 'radius'));
            if (center === undefined || !Number.isFinite(radius)) {
                return undefined;
            }
            if (construction) {
                constructionComments.push(`# construction circle center=${tuple(center)} radius=${formatNumber(radius)}`);
            } else {
                circles.push({ id, center, radius });
            }
        } else if (type === 'arc') {
            const center = points.get(String(getField(p, 'c_id', 'centerId')));
            const p1 = String(getField(p, 'start_id', 'startId'));
            const p2 = String(getField(p, 'end_id', 'endId'));
            const radius = Number(getField(p, 'radius'));
            const startAngle = Number(getField(p, 'start_angle', 'startAngle'));
            const endAngle = Number(getField(p, 'end_angle', 'endAngle'));
            if (
                center === undefined ||
                !points.has(p1) ||
                !points.has(p2) ||
                !Number.isFinite(radius) ||
                !Number.isFinite(startAngle) ||
                !Number.isFinite(endAngle)
            ) {
                return undefined;
            }
            if (construction) {
                constructionComments.push(
                    `# construction arc center=${tuple(center)} radius=${formatNumber(radius)} ` +
                        `sweep=${formatNumber((endAngle - startAngle) * RAD_TO_DEG)}deg`
                );
            } else {
                segments.push({ id, kind: 'arc', p1, p2, center, radius, startAngle, endAngle });
            }
        } else if (type === 'ellipse') {
            const center = points.get(String(getField(p, 'c_id', 'centerId')));
            const focus1 = points.get(String(getField(p, 'focus1_id', 'focus1Id')));
            const radmin = Number(getField(p, 'radmin'));
            if (center === undefined || focus1 === undefined || !Number.isFinite(radmin)) {
                return undefined;
            }
            if (construction) {
                constructionComments.push(
                    `# construction ellipse center=${tuple(center)} focus=${tuple(focus1)} radmin=${formatNumber(radmin)}`
                );
            } else {
                const axes = ellipseAxes({ x: center[0], y: center[1] }, { x: focus1[0], y: focus1[1] }, radmin);
                ellipses.push({
                    id,
                    center,
                    major: axes.major,
                    minor: axes.minor,
                    rotation: axes.phi * RAD_TO_DEG
                });
            }
        } else if (type === 'bspline') {
            const poleIds = getField(p, 'pole_ids', 'poleIds');
            if (!Array.isArray(poleIds) || poleIds.length < 2) {
                return undefined;
            }
            const weights = getField(p, 'weights');
            const knots = getField(p, 'knots');
            const mult = getField(p, 'mult');
            const degree = Number(getField(p, 'degree'));
            const periodic = Boolean(getField(p, 'periodic'));
            if (
                !Array.isArray(weights) ||
                !Array.isArray(knots) ||
                !Array.isArray(mult) ||
                !Number.isInteger(degree) ||
                periodic ||
                poleIds.length < degree + 1 ||
                weights.length !== poleIds.length ||
                knots.length !== mult.length ||
                (weights as unknown[]).some((w) => Number(w) !== 1)
            ) {
                return undefined;
            }
            const poleCoords: [number, number][] = [];
            for (const poleId of poleIds as unknown[]) {
                const coord = points.get(String(poleId));
                if (coord === undefined) {
                    return undefined;
                }
                poleCoords.push(coord);
            }
            if (!knots.every((k) => Number.isFinite(Number(k))) || !mult.every((m) => Number.isInteger(Number(m)))) {
                return undefined;
            }
            if (construction) {
                constructionComments.push(`# construction bspline poles=${poleCoords.map(tuple).join(', ')}`);
            } else {
                segments.push({
                    id,
                    kind: 'bspline',
                    p1: String(poleIds[0]),
                    p2: String(poleIds[poleIds.length - 1]),
                    poles: poleCoords,
                    knots: knots.map(Number),
                    mult: mult.map(Number),
                    degree
                });
            }
        }
    }
    return { points, segments, circles, ellipses, constructionComments };
}

/** Group segments into closed loops by shared endpoint point ids (union-find). */
function assembleLoops(segments: SegmentPrim[]): SegmentPrim[][] {
    const parent = new Map<string, string>();
    const find = (x: string): string => {
        let root = x;
        while (parent.get(root) !== root) {
            root = parent.get(root)!;
        }
        let node = x;
        while (parent.get(node) !== node) {
            const next = parent.get(node)!;
            parent.set(node, root);
            node = next;
        }
        return root;
    };
    for (const seg of segments) {
        if (!parent.has(seg.p1)) {
            parent.set(seg.p1, seg.p1);
        }
        if (!parent.has(seg.p2)) {
            parent.set(seg.p2, seg.p2);
        }
        const r1 = find(seg.p1);
        const r2 = find(seg.p2);
        if (r1 !== r2) {
            parent.set(r2, r1);
        }
    }
    const byRoot = new Map<string, SegmentPrim[]>();
    for (const seg of segments) {
        const root = find(seg.p1);
        const loop = byRoot.get(root);
        if (loop !== undefined) {
            loop.push(seg);
        } else {
            byRoot.set(root, [seg]);
        }
    }
    const loops = [...byRoot.values()];
    // Deterministic order: by the smallest segment id in each loop.
    const minId = (loop: SegmentPrim[]) => loop.map((s) => s.id).sort()[0];
    loops.sort((a, b) => (minId(a) < minId(b) ? -1 : 1));
    return loops;
}

/** Sample one segment into ordered polygon points (excluding the end point). */
function sampleSegment(seg: SegmentPrim, from: string, points: Map<string, [number, number]>): [number, number][] {
    const start = points.get(from)!;
    if (seg.kind === 'line') {
        return [start];
    }
    if (seg.kind === 'bspline') {
        let samples = sampleBSplineCurve(
            seg.poles!.map(([x, y]) => ({ x, y })),
            seg.knots!,
            seg.mult!,
            seg.degree!,
            ARC_SAMPLES
        );
        if (from !== seg.p1) {
            samples = [...samples].reverse();
        }
        return samples.slice(0, -1).map((p) => [p.x, p.y]);
    }
    const samples: [number, number][] = [];
    const forward = from === seg.p1;
    const a0 = forward ? seg.startAngle! : seg.endAngle!;
    const sweep = forward ? seg.endAngle! - seg.startAngle! : seg.startAngle! - seg.endAngle!;
    for (let i = 0; i < ARC_SAMPLES; i++) {
        const angle = a0 + (sweep * i) / ARC_SAMPLES;
        samples.push([seg.center![0] + seg.radius! * Math.cos(angle), seg.center![1] + seg.radius! * Math.sin(angle)]);
    }
    return samples;
}

/**
 * Walk a loop's segments into a polygon (chord-approximated arcs) for
 * containment tests. Returns undefined when the loop is not a simple cycle.
 */
function sampleLoopPolygon(loop: SegmentPrim[], points: Map<string, [number, number]>): [number, number][] | undefined {
    const polygon: [number, number][] = [];
    const used = new Set<string>();
    let current = loop[0].p1;
    const start = current;
    for (let step = 0; step < loop.length; step++) {
        const next = loop.find((s) => !used.has(s.id) && (s.p1 === current || s.p2 === current));
        if (next === undefined) {
            return undefined;
        }
        used.add(next.id);
        polygon.push(...sampleSegment(next, current, points));
        current = next.p1 === current ? next.p2 : next.p1;
    }
    return current === start && polygon.length >= 3 ? polygon : undefined;
}

/** Shoelace area of a polygon (absolute value). */
function polygonArea(polygon: [number, number][]): number {
    let area = 0;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        area += polygon[j][0] * polygon[i][1] - polygon[i][0] * polygon[j][1];
    }
    return Math.abs(area) / 2;
}

/** Area-weighted centroid of a polygon. */
function polygonCentroid(polygon: [number, number][]): [number, number] {
    let cx = 0;
    let cy = 0;
    let area = 0;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const cross = polygon[j][0] * polygon[i][1] - polygon[i][0] * polygon[j][1];
        area += cross;
        cx += (polygon[j][0] + polygon[i][0]) * cross;
        cy += (polygon[j][1] + polygon[i][1]) * cross;
    }
    if (Math.abs(area) < 1e-12) {
        return polygon[0];
    }
    return [cx / (3 * area), cy / (3 * area)];
}

/** Ray-casting point-in-polygon test on a chord-approximated loop. */
function pointInPolygon(point: [number, number], polygon: [number, number][]): boolean {
    let inside = false;
    const [px, py] = point;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const [xi, yi] = polygon[i];
        const [xj, yj] = polygon[j];
        if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
            inside = !inside;
        }
    }
    return inside;
}

/**
 * A closed sketch profile: a line/arc/B-spline loop (with its
 * chord-approximated polygon) or a full circle/ellipse. Mirrors the backend's
 * wire classification: each profile carries an area and a reference point used
 * for containment tests.
 */
interface Profile {
    kind: 'loop' | 'circle' | 'ellipse';
    loop?: SegmentPrim[];
    circle?: CirclePrim;
    ellipse?: EllipsePrim;
    polygon?: [number, number][];
    area: number;
    testPoint: [number, number];
}

function profileContainsPoint(profile: Profile, point: [number, number]): boolean {
    if (profile.kind === 'circle') {
        const circle = profile.circle!;
        const dx = point[0] - circle.center[0];
        const dy = point[1] - circle.center[1];
        return Math.sqrt(dx * dx + dy * dy) < circle.radius - 1e-9;
    }
    if (profile.kind === 'ellipse') {
        // Coarse containment via the analytic axes; only used to pair holes.
        const ellipse = profile.ellipse!;
        const phi = (ellipse.rotation * Math.PI) / 180;
        const dx = point[0] - ellipse.center[0];
        const dy = point[1] - ellipse.center[1];
        const lx = dx * Math.cos(-phi) - dy * Math.sin(-phi);
        const ly = dx * Math.sin(-phi) + dy * Math.cos(-phi);
        return (lx * lx) / (ellipse.major * ellipse.major) + (ly * ly) / (ellipse.minor * ellipse.minor) < 1 - 1e-9;
    }
    return profile.polygon !== undefined && pointInPolygon(point, profile.polygon);
}

/**
 * Classify profiles as outer profiles or holes following the backend's
 * pairing rule: sorted by area descending, a profile whose reference point
 * lies inside an already-accepted outer profile is a hole of that outer
 * (nested profiles inside holes stay holes — there is no island parity).
 */
function classifyProfiles(profiles: Profile[]): { outers: Profile[]; holes: Profile[] } {
    const sorted = [...profiles].sort((a, b) => b.area - a.area);
    const outers: Profile[] = [];
    const holes: Profile[] = [];
    for (const profile of sorted) {
        if (outers.some((outer) => profileContainsPoint(outer, profile.testPoint))) {
            holes.push(profile);
        } else {
            outers.push(profile);
        }
    }
    return { outers, holes };
}

function emitSegmentLine(seg: SegmentPrim, points: Map<string, [number, number]>, indent: string): string {
    if (seg.kind === 'line') {
        return `${indent}bd.Line(${tuple(points.get(seg.p1)!)}, ${tuple(points.get(seg.p2)!)})`;
    }
    if (seg.kind === 'bspline') {
        const poles = `[${seg.poles!.map(tuple).join(', ')}]`;
        const knots = `[${seg.knots!.map(formatNumber).join(', ')}]`;
        const mult = `[${seg.mult!.join(', ')}]`;
        return `${indent}_bspline_edge(${poles}, ${knots}, ${mult}, ${seg.degree})`;
    }
    const startDeg = seg.startAngle! * RAD_TO_DEG;
    const sweepDeg = (seg.endAngle! - seg.startAngle!) * RAD_TO_DEG;
    return (
        `${indent}bd.CenterArc(${tuple(seg.center!)}, ${formatNumber(seg.radius!)}, ` +
        `${formatNumber(startDeg)}, ${formatNumber(sweepDeg)})`
    );
}

function emitProfile(profile: Profile, subtract: boolean, points: Map<string, [number, number]>, lines: string[]): void {
    if (profile.kind === 'circle') {
        const circle = profile.circle!;
        const mode = subtract ? ', mode=bd.Mode.SUBTRACT' : '';
        lines.push(`${INDENT}${INDENT}with bd.Locations(${tuple(circle.center)}):`);
        lines.push(`${INDENT}${INDENT}${INDENT}bd.Circle(${formatNumber(circle.radius)}${mode})`);
        return;
    }
    if (profile.kind === 'ellipse') {
        const ellipse = profile.ellipse!;
        const mode = subtract ? ', mode=bd.Mode.SUBTRACT' : '';
        lines.push(`${INDENT}${INDENT}with bd.Locations(${tuple(ellipse.center)}):`);
        lines.push(
            `${INDENT}${INDENT}${INDENT}bd.Ellipse(${formatNumber(ellipse.major)}, ${formatNumber(ellipse.minor)}, ` +
                `rotation=${formatNumber(ellipse.rotation)}${mode})`
        );
        return;
    }
    const mode = subtract ? ', mode=bd.Mode.SUBTRACT' : '';
    if (profile.loop!.some((seg) => seg.kind === 'bspline')) {
        // B-spline edges come from the OCP-based `_bspline_edge` helper, which
        // the BuildLine context cannot capture; pass the explicit edge list to
        // make_face instead (the helper is emitted at module scope).
        lines.push(`${INDENT}${INDENT}bd.make_face([`);
        for (const seg of profile.loop!) {
            lines.push(`${emitSegmentLine(seg, points, INDENT + INDENT + INDENT)},`);
        }
        lines.push(`${INDENT}${INDENT}]${mode})`);
        return;
    }
    lines.push(`${INDENT}${INDENT}with bd.BuildLine():`);
    for (const seg of profile.loop!) {
        lines.push(emitSegmentLine(seg, points, INDENT + INDENT + INDENT));
    }
    lines.push(`${INDENT}${INDENT}bd.make_face(${subtract ? 'mode=bd.Mode.SUBTRACT' : ''})`);
}

function emitSketchFunction(
    sketch: SketchDef,
    funcName: string,
    datumById: Map<string, DatumPlane>,
    datumVarById: Map<string, string>
): { lines: string[]; buildable: boolean } {
    const datum = datumById.get(sketch.datumId);
    if (datum === undefined || !datumKindExportable(datum.kind)) {
        const reason = datum === undefined ? 'an unknown datum' : `a ${datum.kind} datum`;
        return {
            buildable: false,
            lines: [`# TODO(manual): sketch "${sketch.name}" is on ${reason} and cannot be exported automatically.`]
        };
    }

    const parsed = parseSketchPrimitives(sketch);
    if (parsed === undefined || (parsed.segments.length === 0 && parsed.circles.length === 0 && parsed.ellipses.length === 0)) {
        return {
            buildable: false,
            lines: [`# TODO(manual): sketch "${sketch.name}" has no exportable solved geometry.`]
        };
    }

    const profiles: Profile[] = [];
    for (const loop of assembleLoops(parsed.segments)) {
        const polygon = sampleLoopPolygon(loop, parsed.points);
        if (polygon === undefined) {
            // Not a simple closed cycle; the backend rejects open wires, so the
            // exported script fails at make_face the same way. Emit as an outer.
            profiles.push({ kind: 'loop', loop, area: 0, testPoint: [0, 0] });
        } else {
            profiles.push({
                kind: 'loop',
                loop,
                polygon,
                area: polygonArea(polygon),
                testPoint: polygonCentroid(polygon)
            });
        }
    }
    for (const circle of parsed.circles) {
        profiles.push({
            kind: 'circle',
            circle,
            area: Math.PI * circle.radius * circle.radius,
            testPoint: circle.center
        });
    }
    for (const ellipse of parsed.ellipses) {
        profiles.push({
            kind: 'ellipse',
            ellipse,
            area: Math.PI * ellipse.major * ellipse.minor,
            testPoint: ellipse.center
        });
    }
    const { outers, holes } = classifyProfiles(profiles);

    const datumVar = datumVarById.get(sketch.datumId)!;
    const lines: string[] = [];
    lines.push(`def ${funcName}():`);
    lines.push(`${INDENT}with bd.BuildSketch(${datumVar}) as sk:`);
    for (const profile of outers) {
        emitProfile(profile, false, parsed.points, lines);
    }
    for (const profile of holes) {
        emitProfile(profile, true, parsed.points, lines);
    }
    for (const comment of parsed.constructionComments) {
        lines.push(`${INDENT}${INDENT}${comment}`);
    }
    if (sketch.externalRefs !== undefined && sketch.externalRefs.length > 0) {
        lines.push(`${INDENT}${INDENT}# External geometry references (projected construction geometry)`);
        for (const ref of sketch.externalRefs) {
            lines.push(`${INDENT}${INDENT}# TODO(manual): ${summarizeRef(ref)}`);
        }
    }
    lines.push(`${INDENT}return sk.sketch`);
    return { lines, buildable: true };
}

// ---------------------------------------------------------------------------
// Feature emission
// ---------------------------------------------------------------------------

/**
 * Datum kinds with a direct `bd.Plane` assignment in the export. Face datums
 * and reference-dependent datums (threePoint/midplane/line2Point)
 * degrade to `# TODO(manual):`, so sketches and datum-referencing features
 * built on them hatch as well.
 */
function datumKindExportable(kind: string): boolean {
    return kind === 'XY' || kind === 'YZ' || kind === 'XZ' || kind === 'offset';
}

function topologicalFeatureOrder(doc: NukeCadDocument): FeatureDef[] {
    const graph = new FeatureGraph(doc.features);
    const order = graph.topologicalOrder();
    const byId = new Map(doc.features.map((f) => [f.id, f]));
    return order.map((id) => byId.get(id)!).filter((f): f is FeatureDef => f !== undefined);
}

/**
 * Build the solid-producing expression (extrude/revolve) for a sketch-based
 * feature, or undefined when it cannot be exported.
 */
function sketchSolidExpr(feature: FeatureDef, sketchFuncById: Map<string, string>, unbuildableSketches: Set<string>): string | undefined {
    if (feature.sketchId === undefined || unbuildableSketches.has(feature.sketchId)) {
        return undefined;
    }
    const func = sketchFuncById.get(feature.sketchId);
    if (func === undefined) {
        return undefined;
    }
    const params = feature.params as Record<string, unknown>;
    if (feature.type === 'pad' || feature.type === 'pocket') {
        if (params.upToFace !== undefined || params.upToBody !== undefined) {
            return undefined;
        }
        // Only blind ends are statically exportable; First/Last/Face/ThroughAll
        // depend on the target body's current B-rep and hatch to # TODO(manual):.
        const end = typeof params.end === 'string' ? params.end : 'blind';
        if (end !== 'blind') {
            return undefined;
        }
        const length = Number(params.length);
        if (!Number.isFinite(length)) {
            return undefined;
        }
        // twoSided splits the length equally both ways, like symmetric.
        const symmetric = Boolean(params.symmetric) || Boolean(params.twoSided);
        const args = [`amount=${symmetric ? `${formatNumber(length)} / 2` : formatNumber(length)}`];
        if (typeof params.axis === 'string') {
            args.push(`dir=${tuple(axisComponents(params.axis))}`);
        }
        if (symmetric) {
            args.push('both=True');
        }
        return `bd.extrude(${func}(), ${args.join(', ')})`;
    }
    if (feature.type === 'revolve' || feature.type === 'groove') {
        // Only blind revolves are statically exportable; throughAll spans the
        // target body's bbox and hatches to # TODO(manual): like the non-blind
        // pad/pocket ends (reference-dependent, never faked).
        const end = typeof params.end === 'string' ? params.end : 'blind';
        if (end !== 'blind') {
            return undefined;
        }
        const angle = Number(params.angle);
        if (!Number.isFinite(angle) || typeof params.axis !== 'string') {
            return undefined;
        }
        return `bd.revolve(${func}(), axis=bd.Axis.${params.axis.toUpperCase()}, revolution_arc=${formatNumber(angle)})`;
    }
    return undefined;
}

function emitFeature(
    feature: FeatureDef,
    doc: NukeCadDocument,
    bodyVarById: Map<string, string>,
    sketchFuncById: Map<string, string>,
    datumVarById: Map<string, string>,
    datumById: Map<string, DatumPlane>,
    curveVarById: Map<string, string>,
    unbuildableSketches: Set<string>
): string[] | undefined {
    const params = feature.params as Record<string, unknown>;
    const bodyVar = bodyVarById.get(feature.body);
    if (bodyVar === undefined) {
        return undefined;
    }

    if (feature.type === 'pad' || feature.type === 'pocket' || feature.type === 'revolve' || feature.type === 'groove') {
        const expr = sketchSolidExpr(feature, sketchFuncById, unbuildableSketches);
        if (expr === undefined) {
            return undefined;
        }
        if (feature.type === 'pad' || feature.type === 'revolve') {
            // Known divergence: the backend appends additive tools as a Compound
            // (erroring on same-body overlap in `_combine_additive`), while the
            // exported script fuses with `+`. Overlapping additive features
            // therefore export to a script whose geometry differs from a
            // backend rebuild (which rejects the document).
            return [`${bodyVar} = ${bodyVar} + ${expr} if ${bodyVar} is not None else ${expr}  # ${feature.name}`];
        }
        return [`${bodyVar} = ${bodyVar} - ${expr}  # ${feature.name}`];
    }

    if (feature.type === 'sweep' || feature.type === 'pipe') {
        const tool = curveSweepTool(feature, doc, sketchFuncById, datumVarById, curveVarById, unbuildableSketches);
        if (tool === undefined) {
            return undefined;
        }
        // Sweep/pipe are additive-only, like pad/revolve.
        return [...tool.lines, `${bodyVar} = ${bodyVar} + ${tool.expr} if ${bodyVar} is not None else ${tool.expr}  # ${feature.name}`];
    }

    if (feature.type === 'loft') {
        const expr = loftSolidExpr(feature, sketchFuncById, unbuildableSketches);
        if (expr === undefined) {
            return undefined;
        }
        // Loft is additive-only, like pad/revolve.
        return [`${bodyVar} = ${bodyVar} + ${expr} if ${bodyVar} is not None else ${expr}  # ${feature.name}`];
    }

    if (feature.type === 'helicalSweep') {
        const tool = helicalSweepTool(feature, doc, sketchFuncById, datumVarById, unbuildableSketches);
        if (tool === undefined) {
            return undefined;
        }
        // Subtractive helical sweeps cut the tool instead of merging it.
        const op = params.subtractive === true ? '-' : '+';
        return [...tool.lines, `${bodyVar} = ${bodyVar} ${op} ${tool.expr} if ${bodyVar} is not None else ${tool.expr}  # ${feature.name}`];
    }

    if (feature.type === 'primitive') {
        const expr = primitiveSolidExpr(feature, datumVarById, datumById);
        if (expr === undefined) {
            return undefined;
        }
        // Subtractive primitives cut the tool instead of merging it.
        const op = params.subtractive === true ? '-' : '+';
        return [`${bodyVar} = ${bodyVar} ${op} ${expr} if ${bodyVar} is not None else ${expr}  # ${feature.name}`];
    }

    if (feature.type === 'booleanFuse' || feature.type === 'booleanCut' || feature.type === 'booleanCommon') {
        const targetVar = bodyVarById.get(String(params.targetBody ?? feature.body));
        if (targetVar === undefined) {
            return undefined;
        }
        const toolBodies = Array.isArray(params.toolBodies) ? (params.toolBodies as string[]) : [];
        const toolVars = toolBodies.map((toolId) => bodyVarById.get(toolId)).filter((v): v is string => v !== undefined);
        if (toolVars.length === 0) {
            return [`# ${feature.name} (no tool bodies)`];
        }
        const op = feature.type === 'booleanFuse' ? 'fuse' : feature.type === 'booleanCut' ? 'cut' : 'intersect';
        const toolsExpr = toolVars.length === 1 ? toolVars[0] : `(${toolVars.join(' + ')})`;
        const lines = [`${targetVar} = ${targetVar}.${op}(${toolsExpr})  # ${feature.name}`];
        if (!params.keepTools) {
            for (const toolVar of toolVars) {
                if (toolVar !== targetVar) {
                    lines.push(`${toolVar} = None  # consumed by ${feature.name}`);
                }
            }
        }
        return lines;
    }

    if (feature.type === 'linearPattern' || feature.type === 'circularPattern' || feature.type === 'mirror') {
        return emitPatternOrMirror(feature, doc, bodyVar, sketchFuncById, datumVarById, datumById, curveVarById, unbuildableSketches);
    }

    return undefined;
}

/**
 * Solid-producing expression for a sweep/pipe feature, or undefined when it
 * cannot be exported.
 *
 * The section is repositioned to the path start: a build123d `Plane` built
 * from the path's start point and tangent, applied relative to the section's
 * own frame (the sketch datum for sweep, the global XY frame for the pipe's
 * generated circle). `frenet` is build123d's default frame behavior;
 * `fixedBinormal` cannot be expressed directly and is emitted with the
 * allowed `# TODO(manual):` escape hatch above the sweep.
 */
function curveSweepTool(
    feature: FeatureDef,
    doc: NukeCadDocument,
    sketchFuncById: Map<string, string>,
    datumVarById: Map<string, string>,
    curveVarById: Map<string, string>,
    unbuildableSketches: Set<string>
): { lines: string[]; expr: string } | undefined {
    const params = feature.params as Record<string, unknown>;
    const pathCurveId = typeof params.pathCurveId === 'string' ? params.pathCurveId : '';
    const pathVar = curveVarById.get(pathCurveId);
    if (pathVar === undefined || pathCurveId.length === 0) {
        return undefined;
    }
    const orientation = params.orientation;
    if (orientation !== 'frenet' && orientation !== 'fixedBinormal') {
        return undefined;
    }
    const planeVar = sanitizeIdentifier(`_sweep_plane_${feature.id}`);
    const lines: string[] = [];
    if (orientation === 'fixedBinormal') {
        lines.push(
            `# TODO(manual): binormal-locked orientation — "${feature.name}" sweeps with a fixed binormal ` +
                `${JSON.stringify(params.binormal ?? null)}; build123d's bd.sweep cannot lock the binormal directly.`
        );
    }
    lines.push(`${planeVar} = bd.Plane(${pathVar} @ 0, z_dir=${pathVar}.tangent_at(0))`);
    if (feature.type === 'sweep') {
        const section = sweepSectionExpr(feature, doc, planeVar, sketchFuncById, datumVarById, unbuildableSketches);
        if (section === undefined) {
            return undefined;
        }
        return { lines, expr: `bd.sweep(${section}, path=${pathVar})` };
    }
    const radius = Number(params.radius);
    if (!Number.isFinite(radius) || radius <= 0) {
        return undefined;
    }
    return { lines, expr: `bd.sweep(bd.Circle(${formatNumber(radius)}).moved(${planeVar}.location), path=${pathVar})` };
}

/**
 * Sketch section expression repositioned from its own datum frame onto the
 * sweep start plane: `<sketchFn>().moved(<planeVar>.location *
 * <datumVar>.location.inverse)`. Shared by sweep and helical sweep; returns
 * undefined when the section sketch cannot be exported.
 */
function sweepSectionExpr(
    feature: FeatureDef,
    doc: NukeCadDocument,
    planeVar: string,
    sketchFuncById: Map<string, string>,
    datumVarById: Map<string, string>,
    unbuildableSketches: Set<string>
): string | undefined {
    if (feature.sketchId === undefined || unbuildableSketches.has(feature.sketchId)) {
        return undefined;
    }
    const func = sketchFuncById.get(feature.sketchId);
    const sketch = doc.sketches.find((s) => s.id === feature.sketchId);
    const datumVar = sketch !== undefined ? datumVarById.get(sketch.datumId) : undefined;
    if (func === undefined || datumVar === undefined) {
        return undefined;
    }
    return `${func}().moved(${planeVar}.location * ${datumVar}.location.inverse)`;
}

/**
 * Solid-producing expression for a loft feature, or undefined when it cannot
 * be exported.
 *
 * Sections are emitted in document order via `bd.loft`; each section goes
 * through its sketch function (built on its own datum, so loft sections keep
 * their world placement). A section sketch that cannot be exported — e.g. one
 * on a face datum — degrades the whole feature to `emitManualTodo`, like
 * sweep's unknown-curve path.
 */
function loftSolidExpr(feature: FeatureDef, sketchFuncById: Map<string, string>, unbuildableSketches: Set<string>): string | undefined {
    const params = feature.params as Record<string, unknown>;
    if (typeof params.ruled !== 'boolean' || !Array.isArray(params.sectionSketchIds)) {
        return undefined;
    }
    const funcs: string[] = [];
    for (const sid of params.sectionSketchIds) {
        if (typeof sid !== 'string' || sid.length === 0 || unbuildableSketches.has(sid)) {
            return undefined;
        }
        const func = sketchFuncById.get(sid);
        if (func === undefined) {
            return undefined;
        }
        funcs.push(`${func}()`);
    }
    if (funcs.length < 2) {
        return undefined;
    }
    return `bd.loft([${funcs.join(', ')}], ruled=${params.ruled ? 'True' : 'False'})`;
}

/**
 * Tool lines + solid-producing expression for a helical sweep feature, or
 * undefined when it cannot be exported.
 *
 * The helix is derived from params (no document curve is involved):
 * `bd.Helix(pitch, height=pitch*turns, radius, direction, lefthand)` becomes
 * the sweep path, the section is repositioned to the helix start via the same
 * `_sweep_plane` machinery as sweep, and `fixedBinormal` keeps the
 * `# TODO(manual):` hatch (build123d cannot lock the binormal directly).
 */
function helicalSweepTool(
    feature: FeatureDef,
    doc: NukeCadDocument,
    sketchFuncById: Map<string, string>,
    datumVarById: Map<string, string>,
    unbuildableSketches: Set<string>
): { lines: string[]; expr: string } | undefined {
    const params = feature.params as Record<string, unknown>;
    const axis = typeof params.axis === 'string' ? params.axis.toUpperCase() : '';
    if (axis !== 'X' && axis !== 'Y' && axis !== 'Z') {
        return undefined;
    }
    const startRadius = Number(params.startRadius);
    const pitch = Number(params.pitch);
    const turns = Number(params.turns);
    if (
        !Number.isFinite(startRadius) ||
        startRadius <= 0 ||
        !Number.isFinite(pitch) ||
        pitch <= 0 ||
        !Number.isFinite(turns) ||
        turns <= 0
    ) {
        return undefined;
    }
    const orientation = params.orientation;
    if (orientation !== 'frenet' && orientation !== 'fixedBinormal') {
        return undefined;
    }
    const helixVar = sanitizeIdentifier(`_helix_${feature.id}`);
    const planeVar = sanitizeIdentifier(`_sweep_plane_${feature.id}`);
    const lines: string[] = [];
    if (orientation === 'fixedBinormal') {
        lines.push(
            `# TODO(manual): binormal-locked orientation — "${feature.name}" sweeps with a fixed binormal ` +
                `${JSON.stringify(params.binormal ?? null)}; build123d's bd.sweep cannot lock the binormal directly.`
        );
    }
    lines.push(
        `${helixVar} = bd.Helix(pitch=${formatNumber(pitch)}, height=${formatNumber(pitch * turns)}, ` +
            `radius=${formatNumber(startRadius)}, direction=${tuple(axisComponents(axis.toLowerCase()))}, ` +
            `lefthand=${params.leftHanded === true ? 'True' : 'False'})`
    );
    lines.push(`${planeVar} = bd.Plane(${helixVar} @ 0, z_dir=${helixVar}.tangent_at(0))`);
    const section = sweepSectionExpr(feature, doc, planeVar, sketchFuncById, datumVarById, unbuildableSketches);
    if (section === undefined) {
        return undefined;
    }
    return { lines, expr: `bd.sweep(${section}, path=${helixVar})` };
}

/**
 * Solid-producing expression for a primitive feature, or undefined when it
 * cannot be exported.
 *
 * Primitives are fully static: the shape constructor places the solid on the
 * datum workplane (box centered on the datum origin, cylinder/cone bases in
 * the plane, sphere at the origin, torus in the plane) via the datum plane's
 * location. Reference-dependent datums (face/threePoint/midplane/line2Point)
 * have no exported plane value, so the feature hatches.
 */
function primitiveSolidExpr(
    feature: FeatureDef,
    datumVarById: Map<string, string>,
    datumById: Map<string, DatumPlane>
): string | undefined {
    const params = feature.params as Record<string, unknown>;
    const dimensions = Array.isArray(params.dimensions) ? (params.dimensions as unknown[]).map(Number) : [];
    if (dimensions.some((d) => !Number.isFinite(d) || d <= 0)) {
        return undefined;
    }
    const fmt = dimensions.map(formatNumber);
    let base: string;
    switch (params.shape) {
        case 'box':
            if (fmt.length !== 3) {
                return undefined;
            }
            base = `bd.Box(${fmt.join(', ')})`;
            break;
        case 'cylinder':
            if (fmt.length !== 2) {
                return undefined;
            }
            base = `bd.Cylinder(${fmt.join(', ')}, align=(bd.Align.CENTER, bd.Align.CENTER, bd.Align.MIN))`;
            break;
        case 'sphere':
            if (fmt.length !== 1) {
                return undefined;
            }
            base = `bd.Sphere(${fmt.join(', ')})`;
            break;
        case 'cone':
            if (fmt.length !== 2) {
                return undefined;
            }
            base = `bd.Cone(${fmt[0]}, 0, ${fmt[1]}, align=(bd.Align.CENTER, bd.Align.CENTER, bd.Align.MIN))`;
            break;
        case 'torus':
            if (fmt.length !== 2) {
                return undefined;
            }
            base = `bd.Torus(${fmt.join(', ')})`;
            break;
        default:
            return undefined;
    }
    const datumId = typeof params.datumId === 'string' && params.datumId.length > 0 ? params.datumId : 'datum-xy';
    const datum = datumById.get(datumId);
    const datumVar = datumVarById.get(datumId);
    if (datum === undefined || datumVar === undefined || !datumKindExportable(datum.kind)) {
        return undefined;
    }
    return `${base}.moved(${datumVar}.location)`;
}

function emitPatternOrMirror(
    feature: FeatureDef,
    doc: NukeCadDocument,
    bodyVar: string,
    sketchFuncById: Map<string, string>,
    datumVarById: Map<string, string>,
    datumById: Map<string, DatumPlane>,
    curveVarById: Map<string, string>,
    unbuildableSketches: Set<string>
): string[] | undefined {
    const params = feature.params as Record<string, unknown>;
    const sourceFeature = doc.features.find((f) => f.id === params.source);
    if (
        sourceFeature === undefined ||
        sourceFeature.suppressed ||
        (sourceFeature.type !== 'pad' &&
            sourceFeature.type !== 'pocket' &&
            sourceFeature.type !== 'revolve' &&
            sourceFeature.type !== 'groove' &&
            sourceFeature.type !== 'sweep' &&
            sourceFeature.type !== 'pipe' &&
            sourceFeature.type !== 'loft' &&
            sourceFeature.type !== 'helicalSweep' &&
            sourceFeature.type !== 'primitive')
    ) {
        return undefined;
    }
    let toolExpr: string;
    let toolLines: string[];
    if (sourceFeature.type === 'sweep' || sourceFeature.type === 'pipe') {
        const tool = curveSweepTool(sourceFeature, doc, sketchFuncById, datumVarById, curveVarById, unbuildableSketches);
        if (tool === undefined) {
            return undefined;
        }
        toolExpr = tool.expr;
        toolLines = tool.lines;
    } else if (sourceFeature.type === 'helicalSweep') {
        const tool = helicalSweepTool(sourceFeature, doc, sketchFuncById, datumVarById, unbuildableSketches);
        if (tool === undefined) {
            return undefined;
        }
        toolExpr = tool.expr;
        toolLines = tool.lines;
    } else if (sourceFeature.type === 'loft') {
        const expr = loftSolidExpr(sourceFeature, sketchFuncById, unbuildableSketches);
        if (expr === undefined) {
            return undefined;
        }
        toolExpr = expr;
        toolLines = [];
    } else if (sourceFeature.type === 'primitive') {
        const expr = primitiveSolidExpr(sourceFeature, datumVarById, datumById);
        if (expr === undefined) {
            return undefined;
        }
        toolExpr = expr;
        toolLines = [];
    } else {
        const expr = sketchSolidExpr(sourceFeature, sketchFuncById, unbuildableSketches);
        if (expr === undefined) {
            return undefined;
        }
        toolExpr = expr;
        toolLines = [];
    }
    const sourceSubtractive =
        (sourceFeature.type === 'primitive' || sourceFeature.type === 'helicalSweep') &&
        (sourceFeature.params as Record<string, unknown>).subtractive === true;
    const op =
        !sourceSubtractive &&
        (sourceFeature.type === 'pad' ||
            sourceFeature.type === 'revolve' ||
            sourceFeature.type === 'sweep' ||
            sourceFeature.type === 'pipe' ||
            sourceFeature.type === 'loft' ||
            sourceFeature.type === 'helicalSweep' ||
            sourceFeature.type === 'primitive')
            ? '+'
            : '-';

    // Per-instance uniform scale about each instance's own bbox center,
    // applied after its transform. Scale 1 (or absent) emits exactly as
    // before; anything else goes through the module-level helper.
    const scale = params.scale === undefined ? 1 : Number(params.scale);
    if (!Number.isFinite(scale) || scale <= 0) {
        return undefined;
    }
    const scaleInstance = (expr: string): string => (scale === 1 ? expr : `_scaled_about_center(${expr}, ${formatNumber(scale)})`);

    if (feature.type === 'mirror') {
        const planeExpr = mirrorPlaneExpr(params, datumVarById, datumById);
        if (planeExpr === undefined) {
            return undefined;
        }
        return [`${bodyVar} = ${bodyVar} ${op} ${scaleInstance(`${toolExpr}.mirror(${planeExpr})`)}  # ${feature.name}`];
    }

    const count = Number(params.count);
    if (!Number.isFinite(count)) {
        return undefined;
    }
    const toolVar = sanitizeIdentifier(`_tool_${feature.id}`);
    const lines = [...toolLines, `${toolVar} = ${toolExpr}  # source: ${sourceFeature.name}`];

    if (feature.type === 'linearPattern') {
        const spacing = Number(params.spacing);
        if (!Number.isFinite(spacing)) {
            return undefined;
        }
        // A datum axis mirrors the circular datum-axis path: line2Point
        // datums inline their static unit direction, exportable plane datums
        // ride the datum variable's z_dir (build123d owns the frame), and
        // reference-dependent datums hatch.
        if (typeof params.axisDatumId === 'string' && params.axisDatumId.length > 0) {
            const datum = datumById.get(params.axisDatumId);
            const datumVar = datumVarById.get(params.axisDatumId);
            if (datum === undefined || datumVar === undefined) {
                return undefined;
            }
            if (datum.kind === 'line2Point') {
                const direction = lineDatumUnitDirection(datum);
                if (direction === undefined) {
                    return undefined;
                }
                const [sx, sy, sz] = direction.map((c) => formatNumber(c * spacing));
                lines.push(`for _k in range(1, ${count}):`);
                lines.push(
                    `${INDENT}${bodyVar} = ${bodyVar} ${op} ${scaleInstance(`${toolVar}.moved(bd.Location((${sx} * _k, ${sy} * _k, ${sz} * _k)))`)}`
                );
                lines.push(`# ${feature.name}`);
                return lines;
            }
            if (!datumKindExportable(datum.kind)) {
                return undefined;
            }
            lines.push(`for _k in range(1, ${count}):`);
            lines.push(
                `${INDENT}${bodyVar} = ${bodyVar} ${op} ${scaleInstance(`${toolVar}.moved(bd.Location(${datumVar}.z_dir * ${formatNumber(spacing)} * _k))`)}`
            );
            lines.push(`# ${feature.name}`);
            return lines;
        }
        const axis = String(params.axis ?? 'z');
        if (axis !== 'x' && axis !== 'y' && axis !== 'z') {
            return undefined;
        }
        const [sx, sy, sz] = axisComponents(axis).map((c) => formatNumber(c * spacing));
        lines.push(`for _k in range(1, ${count}):`);
        lines.push(
            `${INDENT}${bodyVar} = ${bodyVar} ${op} ${scaleInstance(`${toolVar}.moved(bd.Location((${sx} * _k, ${sy} * _k, ${sz} * _k)))`)}`
        );
        lines.push(`# ${feature.name}`);
        return lines;
    }

    // circularPattern
    const angle = Number(params.angle ?? 360);
    if (!Number.isFinite(angle)) {
        return undefined;
    }
    const axisExpr = circularAxisExpr(params, datumVarById, datumById);
    if (axisExpr === undefined) {
        return undefined;
    }
    const step = angle === 360 ? 360 / count : angle / (count - 1);
    lines.push(`for _k in range(1, ${count}):`);
    lines.push(`${INDENT}${bodyVar} = ${bodyVar} ${op} ${scaleInstance(`${toolVar}.rotate(${axisExpr}, _k * ${formatNumber(step)})`)}`);
    lines.push(`# ${feature.name}`);
    return lines;
}

/** Axis expression for a circular pattern; undefined when not exportable. */
function circularAxisExpr(
    params: Record<string, unknown>,
    datumVarById: Map<string, string>,
    datumById: Map<string, DatumPlane>
): string | undefined {
    if (typeof params.axisDatumId === 'string') {
        const datum = datumById.get(params.axisDatumId);
        const datumVar = datumVarById.get(params.axisDatumId);
        if (datum === undefined || datumVar === undefined) {
            return undefined;
        }
        // A line2Point datum's axis is fully static: emit it inline instead of
        // referencing the hatched datum variable.
        if (datum.kind === 'line2Point') {
            return lineDatumAxisExpr(datum);
        }
        if (!datumKindExportable(datum.kind)) {
            return undefined;
        }
        return `bd.Axis(${datumVar}.origin, ${datumVar}.z_dir)`;
    }
    const axis = String(params.axis ?? 'z');
    return `bd.Axis.${axis.toUpperCase()}`;
}

/**
 * Static unit direction of a line2Point datum (first point to second), or
 * undefined when its points are malformed (validation rejects those
 * documents; codegen stays defensive).
 */
function lineDatumUnitDirection(datum: DatumPlane): [number, number, number] | undefined {
    if (!Array.isArray(datum.points) || datum.points.length !== 2) {
        return undefined;
    }
    const [a, b] = datum.points;
    if (!isFiniteTriple(a) || !isFiniteTriple(b)) {
        return undefined;
    }
    const dir = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const length = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]);
    if (!(length > 0) || !Number.isFinite(length)) {
        return undefined;
    }
    return [dir[0] / length, dir[1] / length, dir[2] / length];
}

/**
 * Static `bd.Axis` for a line2Point datum, or undefined when its points are
 * malformed (validation rejects those documents; codegen stays defensive).
 */
function lineDatumAxisExpr(datum: DatumPlane): string | undefined {
    if (!Array.isArray(datum.points) || datum.points.length !== 2) {
        return undefined;
    }
    const [a] = datum.points;
    if (!isFiniteTriple(a)) {
        return undefined;
    }
    const unit = lineDatumUnitDirection(datum);
    if (unit === undefined) {
        return undefined;
    }
    return `bd.Axis(${tuple(a as [number, number, number])}, ${tuple(unit)})`;
}

/**
 * Static `bd.Plane` for a threePoint datum, or undefined when its points are
 * malformed or collinear (validation rejects those documents).
 */
function threePointDatumPlaneExpr(datum: DatumPlane): string | undefined {
    if (!Array.isArray(datum.points) || datum.points.length !== 3) {
        return undefined;
    }
    const [a, b, c] = datum.points;
    if (!isFiniteTriple(a) || !isFiniteTriple(b) || !isFiniteTriple(c)) {
        return undefined;
    }
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const normal = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    const length = Math.sqrt(normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2]);
    if (!(length > 0) || !Number.isFinite(length)) {
        return undefined;
    }
    const unit: [number, number, number] = [normal[0] / length, normal[1] / length, normal[2] / length];
    return `bd.Plane(${tuple(a as [number, number, number])}, z_dir=${tuple(unit)})`;
}

function isFiniteTriple(value: unknown): value is [number, number, number] {
    return Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === 'number' && Number.isFinite(v));
}

/** Plane expression for a mirror feature; undefined when not exportable. */
function mirrorPlaneExpr(
    params: Record<string, unknown>,
    datumVarById: Map<string, string>,
    datumById: Map<string, DatumPlane>
): string | undefined {
    if (typeof params.planeDatumId === 'string') {
        const datum = datumById.get(params.planeDatumId);
        const datumVar = datumVarById.get(params.planeDatumId);
        if (datum === undefined || datumVar === undefined) {
            return undefined;
        }
        // A threePoint datum's plane is fully static: emit it inline instead
        // of referencing the hatched datum variable.
        if (datum.kind === 'threePoint') {
            return threePointDatumPlaneExpr(datum);
        }
        if (!datumKindExportable(datum.kind)) {
            return undefined;
        }
        return datumVar;
    }
    const plane = String(params.plane ?? 'XY');
    return `bd.Plane.${plane}`;
}

function axisComponents(axis: string): [number, number, number] {
    switch (axis) {
        case 'x':
            return [1, 0, 0];
        case 'y':
            return [0, 1, 0];
        default:
            return [0, 0, 1];
    }
}

function emitManualTodo(feature: FeatureDef): string[] {
    const params = feature.params as Record<string, unknown>;
    const lines: string[] = [];
    lines.push(`# TODO(manual): ${feature.type} feature "${feature.name}"`);
    for (const [key, value] of Object.entries(params)) {
        const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);
        lines.push(`#   ${key}: ${serialized}`);
    }
    return lines;
}

function uniqueCurveVarName(name: string, existing: Map<string, string>): string {
    const base = sanitizeIdentifier(`curve_${name}`);
    let candidate = base;
    let index = 1;
    const values = new Set(existing.values());
    while (values.has(candidate)) {
        candidate = `${base}_${index++}`;
    }
    return candidate;
}

function curveSourceComment(source: CurveSource): string | undefined {
    if (source.kind === 'points') {
        return undefined;
    }
    if (source.kind === 'parametric') {
        return `source: parametric x=${source.x} y=${source.y} z=${source.z} tStart=${source.tStart} tEnd=${source.tEnd} sampleCount=${source.sampleCount}`;
    }
    return `source: fourier nfp=${source.nfp} order=${source.order}`;
}

// ---------------------------------------------------------------------------
// Assembly emission
// ---------------------------------------------------------------------------

/**
 * Emit the `# Assembly` section for a document with a grounded assembly:
 * per-source instance builds plus `resolveMatePlacement`-equivalent placement
 * code (closed-form `R = Ra·RbT`, `t = pa − R·pb` in the `_mate_solve`
 * helper, threaded in grounded-first BFS order). Instances whose source
 * cannot be built automatically (`.nuke-cad` paths, non-STEP exchange files,
 * per-axis scales) — and mates touching them — degrade to `# TODO(manual):`
 * comments, never faked placements.
 */
function emitAssemblySection(doc: NukeCadDocument, bodyVarById: Map<string, string>, manualFeatures: string[]): string[] {
    const assembly = doc.assembly!;
    const lines: string[] = [];
    lines.push('# Assembly');
    lines.push(`# Grounded instance: "${assembly.groundedInstanceId}"`);

    const bodyIds = new Set(doc.bodies.map((b) => b.id));
    const varOf = (instanceId: string): string => sanitizeIdentifier(`asm_${instanceId}`);
    const frameOf = (connectorId: string): string => sanitizeIdentifier(`_frame_${connectorId}`);

    interface InstancePlan {
        buildable: boolean;
        sourceExpr?: string;
        manualReason?: string;
    }
    const plans = new Map<string, InstancePlan>();
    for (const instance of assembly.instances) {
        const part = instance.part;
        let plan: InstancePlan;
        if (part.startsWith('body:') || bodyIds.has(part)) {
            const bodyId = part.startsWith('body:') ? part.slice('body:'.length) : part;
            const bodyVar = bodyVarById.get(bodyId);
            plan =
                bodyVar === undefined
                    ? { buildable: false, manualReason: `unknown body "${bodyId}"` }
                    : { buildable: true, sourceExpr: bodyVar };
        } else if (/\.(step|stp)$/i.test(part)) {
            plan = { buildable: true, sourceExpr: `bd.import_step(${JSON.stringify(part)})` };
        } else if (/\.nuke-cad$/i.test(part)) {
            plan = { buildable: false, manualReason: `part "${part}" is a .nuke-cad document — build it separately and assign its shape` };
        } else {
            plan = { buildable: false, manualReason: `part "${part}" cannot be imported automatically` };
        }
        if (plan.buildable && instance.scale !== undefined) {
            if (typeof instance.scale === 'number' && instance.scale !== 1) {
                plan.sourceExpr = `bd.scale(${plan.sourceExpr}, ${formatNumber(instance.scale)})`;
            } else if (Array.isArray(instance.scale)) {
                plan = { buildable: false, manualReason: `per-axis scale ${JSON.stringify(instance.scale)} has no build123d equivalent` };
            }
        }
        plans.set(instance.id, plan);
    }

    // Connector frame literals (raw stored axes; `_mate_solve` orthonormalizes).
    for (const connector of assembly.connectors) {
        lines.push(
            `${frameOf(connector.id)} = (${tuple(connector.origin)}, ${tuple(connector.xAxis)}, ${tuple(connector.yAxis)})  # ${connector.instanceId}`
        );
    }

    // Grounded-first BFS over mates (first mate wins, like the backend).
    const adjacency = new Map<string, typeof assembly.mates>();
    for (const instance of assembly.instances) {
        adjacency.set(instance.id, []);
    }
    for (const mate of assembly.mates) {
        adjacency.get(mate.instanceA)?.push(mate);
        adjacency.get(mate.instanceB)?.push(mate);
    }
    const solverOf = new Map<string, (typeof assembly.mates)[number]>();
    const solvedOrder: string[] = [assembly.groundedInstanceId];
    const solved = new Set<string>(solvedOrder);
    const queue = [assembly.groundedInstanceId];
    while (queue.length > 0) {
        const current = queue.shift()!;
        for (const mate of adjacency.get(current) ?? []) {
            const other = mate.instanceA === current ? mate.instanceB : mate.instanceA;
            if (solved.has(other)) {
                continue;
            }
            solved.add(other);
            solverOf.set(other, mate);
            solvedOrder.push(other);
            queue.push(other);
        }
    }
    for (const instance of assembly.instances) {
        if (!solved.has(instance.id)) {
            solvedOrder.push(instance.id);
        }
    }

    const needsHelpers = [...solverOf.entries()].some(
        ([instanceId, mate]) =>
            plans.get(instanceId)?.buildable === true &&
            plans.get(mate.instanceA)?.buildable === true &&
            plans.get(mate.instanceB)?.buildable === true
    );
    if (needsHelpers) {
        lines.push(...mateHelperLines());
    }

    const storedPlacement = (instanceId: string): { pos: string; rot: string } => {
        const instance = assembly.instances.find((candidate) => candidate.id === instanceId)!;
        const matrix: Mat4 = instancePlacementToMatrix(instance.placement);
        const pos = tuple([matrix[3], matrix[7], matrix[11]]);
        const rot = `(${tuple([matrix[0], matrix[1], matrix[2]])}, ${tuple([matrix[4], matrix[5], matrix[6]])}, ${tuple([matrix[8], matrix[9], matrix[10]])})`;
        return { pos, rot };
    };

    for (const instanceId of solvedOrder) {
        const plan = plans.get(instanceId)!;
        const varName = varOf(instanceId);
        if (!plan.buildable) {
            lines.push(`# TODO(manual): instance "${instanceId}" — ${plan.manualReason}. Assign its shape to ${varName}_src manually.`);
            manualFeatures.push(`assembly instance "${instanceId}" (${plan.manualReason})`);
            continue;
        }
        const mate = solverOf.get(instanceId);
        const solvable =
            mate !== undefined && plans.get(mate.instanceA)?.buildable === true && plans.get(mate.instanceB)?.buildable === true;
        if (instanceId === assembly.groundedInstanceId || !solvable) {
            if (mate !== undefined && !solvable) {
                lines.push(
                    `# TODO(manual): mate "${mate.id}" (${mate.type}) requires manual placement — instance "${instanceId}" keeps its stored placement.`
                );
                manualFeatures.push(`assembly mate "${mate.id}" (reference-dependent, kept stored placement)`);
            }
            const stored = storedPlacement(instanceId);
            lines.push(`${varName}_pos = ${stored.pos}`);
            lines.push(`${varName}_rot = ${stored.rot}`);
        } else {
            const fromA = mate.instanceA === instanceId ? mate.instanceB : mate.instanceA;
            const frameSolved = mate.instanceA === instanceId ? frameOf(mate.connectorB) : frameOf(mate.connectorA);
            const frameLocal = mate.instanceA === instanceId ? frameOf(mate.connectorA) : frameOf(mate.connectorB);
            lines.push(`# mate "${mate.id}" (${mate.type}): ${fromA} -> ${instanceId} (first mate wins)`);
            lines.push(
                `${varName}_pos, ${varName}_rot = _mate_solve(_mate_frame(${varOf(fromA)}_pos, ${varOf(fromA)}_rot, ${frameSolved}), ${frameLocal})`
            );
        }
        lines.push(`${varName} = _mate_place(${plan.sourceExpr}, ${varName}_pos, ${varName}_rot)  # instance "${instanceId}"`);
    }

    // Mates that solved nothing (both endpoints unreached is impossible from
    // BFS, but mates touching manual instances need their comment).
    for (const mate of assembly.mates) {
        if (solverOf.has(mate.instanceA) || solverOf.has(mate.instanceB)) {
            continue;
        }
        if (plans.get(mate.instanceA)?.buildable !== true || plans.get(mate.instanceB)?.buildable !== true) {
            lines.push(`# TODO(manual): mate "${mate.id}" (${mate.type}) requires manual placement (unbuildable instance).`);
            manualFeatures.push(`assembly mate "${mate.id}" (reference-dependent, kept stored placement)`);
        }
    }
    return lines;
}

/**
 * Pure-Python mate-placement helpers: `_mate_frame` moves a part-local frame
 * to assembly space, `_mate_solve` is the closed form, `_mate_place` applies
 * a solved placement (rotate about the origin, then move).
 */
function mateHelperLines(): string[] {
    return [
        'import math',
        '',
        '',
        'def _mate_frame(pos, rot, frame):',
        '    """Move a part-local connector frame to assembly space via a placement."""',
        '    origin, x, y = frame',
        '',
        '    def _apply(point):',
        '        return (',
        '            rot[0][0] * point[0] + rot[0][1] * point[1] + rot[0][2] * point[2] + pos[0],',
        '            rot[1][0] * point[0] + rot[1][1] * point[1] + rot[1][2] * point[2] + pos[1],',
        '            rot[2][0] * point[0] + rot[2][1] * point[1] + rot[2][2] * point[2] + pos[2]',
        '        )',
        '',
        '    return (_apply(origin), _apply(x), _apply(y))',
        '',
        '',
        'def _mate_solve(frame_a, frame_b):',
        '    """Closed-form mate solution (mirrors resolveMatePlacement: R = Ra.RbT, t = pa - R.pb)."""',
        '    origin_a, xa, ya = frame_a',
        '    origin_b, xb, yb = frame_b',
        '',
        '    def _orthonormalize(x, y):',
        '        x_len = math.sqrt(sum(c * c for c in x))',
        '        xn = [c / x_len for c in x]',
        '        proj = sum(a * b for a, b in zip(xn, y))',
        '        yo = [b - proj * a for a, b in zip(xn, y)]',
        '        y_len = math.sqrt(sum(c * c for c in yo))',
        '        yn = [c / y_len for c in yo]',
        '        zn = (',
        '            xn[1] * yn[2] - xn[2] * yn[1],',
        '            xn[2] * yn[0] - xn[0] * yn[2],',
        '            xn[0] * yn[1] - xn[1] * yn[0]',
        '        )',
        '        return xn, yn, zn',
        '',
        '    xa, ya, za = _orthonormalize(xa, ya)',
        '    xb, yb, zb = _orthonormalize(xb, yb)',
        '    cols_a = (xa, ya, za)',
        '    cols_b = (xb, yb, zb)',
        '    rot = tuple(',
        '        tuple(sum(cols_a[k][i] * cols_b[k][j] for k in range(3)) for j in range(3)) for i in range(3)',
        '    )',
        '    pos = tuple(',
        '        origin_a[i] - sum(rot[i][j] * origin_b[j] for j in range(3)) for i in range(3)',
        '    )',
        '    return pos, rot',
        '',
        '',
        'def _mate_place(shape, pos, rot):',
        '    """Apply a solved mate placement (rotate about the origin, then move)."""',
        '    trace = rot[0][0] + rot[1][1] + rot[2][2]',
        '    angle = math.degrees(math.acos(max(-1.0, min(1.0, (trace - 1.0) / 2.0))))',
        '    if angle < 1e-9:',
        '        return shape.moved(pos)',
        '    if math.pi - math.radians(angle) < 1e-6:',
        '        diag = (rot[0][0], rot[1][1], rot[2][2])',
        '        k = max(range(3), key=lambda i: diag[i])',
        '        uk = math.sqrt(max(0.0, (diag[k] + 1.0) / 2.0))',
        '        axis = [(rot[k][j] / (2.0 * uk) if j != k and uk > 1e-9 else (uk if j == k else 0.0)) for j in range(3)]',
        '    else:',
        '        s = 2.0 * math.sin(math.radians(angle))',
        '        axis = ((rot[2][1] - rot[1][2]) / s, (rot[0][2] - rot[2][0]) / s, (rot[1][0] - rot[0][1]) / s)',
        '    return shape.rotate(bd.Axis((0, 0, 0), axis), angle).moved(pos)'
    ];
}

// Re-export for consumers that want to reuse the ordering logic.
export { topologicalFeatureOrder };
