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
 * Pure interaction helpers for the Model Outline panel.
 *
 * Covers Ctrl/Cmd-click multi-select bookkeeping and the cross-body overlap
 * auto-fix: parsing the builder's overlap warning text and building the
 * ``booleanFuse`` feature that merges the offending pair.
 *
 * @module nuke-cad/browser/widgets
 */

import { type CadSelection } from '../../state/nuke-cad-state-manager';
import { type FeatureDef, type NukeCadDocument } from '../../../common/cad-document';

/**
 * Toggle one solid inside a multi-selection.
 *
 * With ``additive`` the solid joins (or leaves) the selection and becomes the
 * primary solid; without it the selection collapses to just that solid —
 * matching plain-click semantics. Clicking the primary solid additively
 * deselects it and promotes the remaining first solid to primary.
 */
export function toggleSolidSelection(selection: CadSelection, solidId: number, additive: boolean): CadSelection {
    if (!additive) {
        return { solidId };
    }
    const current = selectionSolidIds(selection);
    if (current.includes(solidId)) {
        const rest = current.filter((id) => id !== solidId);
        if (rest.length === 0) {
            return {};
        }
        return { solidId: rest[0], solidIds: rest };
    }
    const ids = [...current, solidId];
    return { solidId, solidIds: ids };
}

/** All selected solid ids (primary first), or [] for an empty selection. */
export function selectionSolidIds(selection: CadSelection): number[] {
    const { solidId, solidIds } = selection;
    if (solidId === undefined) {
        return [];
    }
    const rest = (solidIds ?? []).filter((id) => id !== solidId);
    return [solidId, ...rest];
}

/**
 * Union boxed solids into a selection (rubber-band box select): keeps the
 * current primary, appends unseen ids in box order. Empty input returns the
 * selection untouched so a miss never clears.
 */
export function addSolidsToSelection(selection: CadSelection, boxed: readonly number[]): CadSelection {
    if (boxed.length === 0) {
        return selection;
    }
    const ids = selectionSolidIds(selection);
    for (const id of boxed) {
        if (!ids.includes(id)) {
            ids.push(id);
        }
    }
    if (ids.length === 0) {
        return selection;
    }
    return ids.length === 1 ? { solidId: ids[0] } : { solidId: ids[0], solidIds: ids };
}

/** Result of {@link parseOverlapWarning}. */
export interface OverlapPair {
    readonly bodyA: string;
    readonly bodyB: string;
}

/**
 * Extract the overlapping body-id pair from a builder warning line.
 *
 * Matches warnings emitted by ``feature_builder._check_cross_body_overlap``:
 * ``bodies 'a' and 'b' overlap (volume …) but are not merged by a boolean``.
 */
export function parseOverlapWarning(warning: string): OverlapPair | undefined {
    const match = warning.match(/bodies '([^']+)' and '([^']+)' overlap/);
    if (match === null) {
        return undefined;
    }
    return { bodyA: match[1], bodyB: match[2] };
}

/** Diagnostic group code for the Model Outline warnings box. */
export type DiagnosticCode = 'overlap' | 'seal' | 'sense' | 'imprint' | 'inspection' | 'other';

/** One grouped warning line; overlap lines may carry a Fuse auto-fix pair. */
export interface DiagnosticItem {
    readonly text: string;
    readonly overlap?: OverlapPair;
}

/** Warnings grouped by diagnostic code for the outline warnings box. */
export interface DiagnosticGroup {
    readonly code: DiagnosticCode;
    readonly title: string;
    readonly hint: string;
    readonly items: DiagnosticItem[];
}

const DIAGNOSTIC_META: Record<DiagnosticCode, { title: string; hint: string }> = {
    overlap: { title: 'Overlaps', hint: 'Fuse a pair in place, or separate the bodies when the overlap is intentional.' },
    seal: { title: 'Seal', hint: 'Check sealCheck.openEdgeCount; close gaps before DAGMC export.' },
    sense: { title: 'Surface senses', hint: 'Inspect open edges and re-run imprint.' },
    imprint: { title: 'Imprint recovery', hint: 'Fallbacks are reported; accept the warning or tighten CAD gaps.' },
    inspection: { title: 'Inspection gates', hint: 'Warnings only; review mass properties and mesh deviation.' },
    other: { title: 'Other warnings', hint: '' }
};

const DIAGNOSTIC_ORDER: readonly DiagnosticCode[] = ['overlap', 'seal', 'sense', 'imprint', 'inspection', 'other'];

/**
 * Classify one build/dagmc warning line into a diagnostic group.
 *
 * Pure string matching over the existing warnings channel (backend
 * ``diagnostics`` entries surface here as ``[DAGMC] …`` lines); geometry is
 * never re-derived. Only ``overlap`` lines with a document body pair are
 * fusible; every other issue renders hint text with no action button.
 */
export function classifyDiagnostic(warning: string): DiagnosticCode {
    if (/sense/i.test(warning)) {
        return 'sense';
    }
    if (/seal|watertight|hole edge|has holes/i.test(warning)) {
        return 'seal';
    }
    if (/imprint|fragment|removeAllDuplicates|tolerance relaxed|graveyard/i.test(warning)) {
        return 'imprint';
    }
    if (/mass-propert|mesh-vs-cad|deviation|gate skipped/i.test(warning)) {
        return 'inspection';
    }
    if (parseOverlapWarning(warning) !== undefined || /overlap/i.test(warning)) {
        return 'overlap';
    }
    return 'other';
}

/**
 * Group warning lines by diagnostic code in stable display order.
 *
 * Empty groups are omitted. Overlap lines keep their parsed body pair so the
 * warnings box can reuse the Fuse auto-fix; non-fusible lines carry no pair
 * and render with the group hint text instead of a button.
 */
export function groupDiagnostics(warnings: readonly string[]): DiagnosticGroup[] {
    const items = new Map<DiagnosticCode, DiagnosticItem[]>();
    for (const text of warnings) {
        const code = classifyDiagnostic(text);
        const list = items.get(code) ?? [];
        const overlap = code === 'overlap' ? parseOverlapWarning(text) : undefined;
        list.push(overlap !== undefined ? { text, overlap } : { text });
        items.set(code, list);
    }
    const groups: DiagnosticGroup[] = [];
    for (const code of DIAGNOSTIC_ORDER) {
        const groupItems = items.get(code);
        if (groupItems !== undefined && groupItems.length > 0) {
            groups.push({ code, title: DIAGNOSTIC_META[code].title, hint: DIAGNOSTIC_META[code].hint, items: groupItems });
        }
    }
    return groups;
}

const SOLID_FEATURE_TYPES: readonly FeatureDef['type'][] = [
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
    'hole',
    'translate',
    'booleanFuse',
    'booleanCut',
    'booleanCommon'
];

/** Last non-suppressed solid-producing feature targeting ``bodyId``. */
export function bodyTipFeature(doc: NukeCadDocument, bodyId: string): string | undefined {
    for (let i = doc.features.length - 1; i >= 0; i--) {
        const feature = doc.features[i];
        if (!feature.suppressed && SOLID_FEATURE_TYPES.includes(feature.type) && feature.body === bodyId) {
            return feature.id;
        }
    }
    return undefined;
}

/**
 * Build the ``booleanFuse`` feature that merges ``bodyB`` into ``bodyA``.
 *
 * Returns ``undefined`` when either body is missing from the document or has
 * no solid features yet (the backend rejects booleans on bodies without a
 * built shape). Tool bodies are consumed (``keepTools: false``) so the
 * backend's cross-body overlap check stops reporting the pair.
 */
export function buildFuseFeature(doc: NukeCadDocument, bodyA: string, bodyB: string, featureId: string): FeatureDef | undefined {
    if (!doc.bodies.some((b) => b.id === bodyA) || !doc.bodies.some((b) => b.id === bodyB)) {
        return undefined;
    }
    const dependsOn: string[] = [];
    const targetTip = bodyTipFeature(doc, bodyA);
    if (targetTip !== undefined) {
        dependsOn.push(targetTip);
    }
    const toolTip = bodyTipFeature(doc, bodyB);
    if (toolTip !== undefined && toolTip !== targetTip) {
        dependsOn.push(toolTip);
    }
    if (targetTip === undefined || toolTip === undefined) {
        return undefined;
    }
    const existing = new Set(doc.features.map((f) => f.name));
    let index = doc.features.length + 1;
    let name = `fuse ${index}`;
    while (existing.has(name)) {
        name = `fuse ${++index}`;
    }
    return {
        id: featureId,
        name,
        type: 'booleanFuse',
        body: bodyA,
        params: { targetBody: bodyA, toolBodies: [bodyB], keepTools: false },
        suppressed: false,
        dependsOn
    };
}
