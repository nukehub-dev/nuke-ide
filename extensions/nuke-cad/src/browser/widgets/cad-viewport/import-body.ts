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
 * Pure planning helpers for the “Import CAD as Body…” flow.
 *
 * The dialog collects a body strategy, a label, an optional source-unit
 * override, and the selected source-solid indexes. This module turns that
 * choice plus one inspection result into the atomic `addImportBodies` batch:
 * body names (unique within the document), optional region labels, and
 * `import` feature parameters carrying the source identity and per-solid
 * signatures.
 *
 * No React/Theia imports: directly unit-testable.
 *
 * @module nuke-cad/browser/widgets
 */

import type { ImportBodyDraft } from '../../document/cad-document-store';
import type { ImportSelection, ImportSolidPick, ImportSourceFormat, ImportSourceUnit } from '../../../common/cad-document';
import type { ImportSolidInfo } from '../../../common/nuke-cad-protocol';

/** Body grouping chosen in the import dialog. */
export type ImportBodyStrategy = 'single' | 'perSolid';

/** Dialog submission consumed by {@link planImportBodies}. */
export interface ImportBodyChoice {
    /** One body holding every selected solid, or one body per selected solid. */
    readonly strategy: ImportBodyStrategy;
    /** Body label typed in the dialog. */
    readonly label: string;
    /** Explicit source-unit override; undefined keeps the detected unit. */
    readonly sourceUnit?: ImportSourceUnit;
    /** 1-based source-solid indexes selected in the dialog. */
    readonly solidIndexes: readonly number[];
}

/** Source identity recorded on every draft built from one inspection. */
export interface ImportBodySourceIdentity {
    /** Document-relative source path stored on the feature. */
    readonly sourcePath: string;
    /** Lowercase SHA-256 hex digest from inspection. */
    readonly sourceHash: string;
    /** Byte size from inspection (advisory). */
    readonly sourceSize?: number;
    /** Source format from inspection or the file extension. */
    readonly sourceFormat?: ImportSourceFormat;
    /** Safety cap stored on the feature (default 500). */
    readonly maxSolids?: number;
}

/** Result of planning an import batch; never mutates the document. */
export type ImportBodyPlan =
    { readonly ok: true; readonly drafts: readonly ImportBodyDraft[] } | { readonly ok: false; readonly error: string };

const IMPORT_EXTENSIONS: Readonly<Record<string, ImportSourceFormat>> = {
    step: 'step',
    stp: 'step',
    iges: 'iges',
    igs: 'iges',
    brep: 'brep'
};

const SOURCE_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** Base name of a POSIX or Windows source path. */
export function importSourceBaseName(sourcePath: string): string {
    const trimmed = sourcePath.replace(/[\\/]+$/, '');
    const base = trimmed.split(/[\\/]/).pop() ?? trimmed;
    return base.length > 0 ? base : 'source';
}

/**
 * Default body label for an import: the source file stem without its exchange
 * extension, falling back to a neutral label when the stem is empty.
 */
export function defaultImportBodyLabel(sourcePath: string): string {
    const base = importSourceBaseName(sourcePath);
    const stem = base.replace(/\.(step|stp|iges|igs|brep)$/i, '').trim();
    return stem.length > 0 ? stem : 'Imported body';
}

/** Infer the import source format from a file path or name. */
export function inferImportSourceFormat(sourcePath: string): ImportSourceFormat | undefined {
    const base = importSourceBaseName(sourcePath);
    const dot = base.lastIndexOf('.');
    if (dot < 0) {
        return undefined;
    }
    return IMPORT_EXTENSIONS[base.slice(dot + 1).toLowerCase()];
}

/**
 * Normalize a backend-reported unit string (`MM`, `millimetre`, …) to the
 * document vocabulary so the dialog can preselect “detected” and avoid storing
 * an override that matches the file.
 */
export function normalizeImportSourceUnit(unit: string | undefined): ImportSourceUnit | undefined {
    const value = unit?.trim().toLowerCase();
    if (value === undefined || value.length === 0) {
        return undefined;
    }
    if (value === 'mm' || value.startsWith('millim')) {
        return 'mm';
    }
    if (value === 'cm' || value.startsWith('centim')) {
        return 'cm';
    }
    if (value === 'm' || value === 'meter' || value === 'metre' || value === 'meters' || value === 'metres') {
        return 'm';
    }
    return undefined;
}

/** One selection pick carrying the inspection fingerprint. */
function pickFor(solid: ImportSolidInfo): ImportSolidPick {
    return {
        index: solid.index,
        signature: { faceCount: solid.faceCount, volume: solid.volume }
    };
}

function uniqueName(base: string, used: Set<string>): string {
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
        candidate = `${base} ${suffix++}`;
    }
    used.add(candidate);
    return candidate;
}

function draftParams(source: ImportBodySourceIdentity, choice: ImportBodyChoice, selection: ImportSelection): ImportBodyDraft['params'] {
    const hasSize = source.sourceSize !== undefined && Number.isInteger(source.sourceSize) && source.sourceSize > 0;
    const hasCap = source.maxSolids !== undefined && Number.isInteger(source.maxSolids) && source.maxSolids > 0;
    return {
        sourcePath: source.sourcePath,
        sourceHash: source.sourceHash,
        selection,
        ...(hasSize ? { sourceSize: source.sourceSize } : {}),
        ...(source.sourceFormat !== undefined ? { sourceFormat: source.sourceFormat } : {}),
        ...(choice.sourceUnit !== undefined ? { sourceUnit: choice.sourceUnit } : {}),
        ...(hasCap ? { maxSolids: source.maxSolids } : {})
    };
}

/**
 * Build the atomic import-body batch from one dialog choice and the latest
 * inspection solids.
 *
 * A single-strategy batch keys its body by the typed label and combines every
 * selected solid into one feature selection. A per-solid batch names each body
 * from the source product name (numbered fallback), keeping names unique both
 * within the batch and against `takenNames`.
 */
export function planImportBodies(
    source: ImportBodySourceIdentity,
    choice: ImportBodyChoice,
    solids: readonly ImportSolidInfo[],
    takenNames: readonly string[] = []
): ImportBodyPlan {
    const label = choice.label.trim();
    if (label.length === 0) {
        return { ok: false, error: 'Enter a body label.' };
    }
    if (!SOURCE_HASH_PATTERN.test(source.sourceHash)) {
        return { ok: false, error: 'The source inspection did not return a valid SHA-256 hash.' };
    }
    const indexes = [...new Set(choice.solidIndexes)].filter((index) => Number.isInteger(index) && index > 0).sort((a, b) => a - b);
    if (indexes.length === 0) {
        return { ok: false, error: 'Select at least one source solid to import.' };
    }
    const byIndex = new Map(solids.map((solid) => [solid.index, solid]));
    const selected: ImportSolidInfo[] = [];
    for (const index of indexes) {
        const solid = byIndex.get(index);
        if (solid === undefined) {
            return { ok: false, error: `Source solid ${index} is no longer present. Re-inspect the source and try again.` };
        }
        selected.push(solid);
    }

    const used = new Set(takenNames);
    if (choice.strategy === 'single') {
        const picks = selected.map((solid) => pickFor(solid));
        const name = uniqueName(label, used);
        const productName = selected.length === 1 ? selected[0].name?.trim() : undefined;
        const draft: ImportBodyDraft = {
            name,
            ...(productName !== undefined && productName.length > 0 && productName !== name ? { label: productName } : {}),
            params: draftParams(source, choice, { mode: 'solids', solids: picks })
        };
        return { ok: true, drafts: [draft] };
    }

    const drafts: ImportBodyDraft[] = selected.map((solid) => {
        const productName = solid.name?.trim();
        const name = uniqueName(productName !== undefined && productName.length > 0 ? productName : `${label} ${solid.index}`, used);
        const draft: ImportBodyDraft = {
            name,
            ...(productName !== undefined && productName.length > 0 && productName !== name ? { label: productName } : {}),
            params: draftParams(source, choice, { mode: 'solids', solids: [pickFor(solid)] })
        };
        return draft;
    });
    return { ok: true, drafts };
}
