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
