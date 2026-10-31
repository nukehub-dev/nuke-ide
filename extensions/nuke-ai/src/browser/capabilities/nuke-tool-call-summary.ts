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
 * Nuke Tool Call Summary
 *
 * Pure parsing helpers for finished Nuke capability tool calls. Theia hands the
 * chat renderer a {@link ToolCallResult}, which may be an empty result, plain
 * text, a plain object, or bounded {@link ToolCallContent}. This module converts
 * that value into one normalized summary without trusting its shape: malformed
 * JSON stays visible as text, unknown objects fall back to generic entries, and
 * detail formatting always produces a bounded, serializable string.
 *
 * @module nuke-ai/browser/capabilities
 */

import { ToolCallContent, ToolCallResult, isToolCallContent } from '@theia/ai-core/lib/common/language-model';

/** A normalized image emitted by a tool result. */
export interface NukeToolCallImage {
    readonly src: string;
    readonly mimeType: string;
    readonly alt: string;
}

/** A sandboxed HTML block emitted by a tool result. */
export interface NukeToolCallHtml {
    readonly html: string;
    readonly title: string;
}

/** A normalized artifact reference. */
export interface NukeToolCallArtifact {
    readonly kind?: string;
    readonly label: string;
    readonly path?: string;
    readonly uri?: string;
}

/** A normalized follow-up capability suggestion. */
export interface NukeToolCallNextAction {
    readonly capability: string;
    readonly reason: string;
}

/** One label/value pair shown in a card's summary grid. */
export interface NukeToolCallSummaryEntry {
    readonly label: string;
    readonly value: string;
}

/** Normalized view of one finished Nuke tool result. */
export interface NukeToolCallSummary {
    readonly ok?: boolean;
    readonly message?: string;
    readonly data?: unknown;
    readonly warnings: readonly string[];
    readonly nextActions: readonly NukeToolCallNextAction[];
    readonly artifacts: readonly NukeToolCallArtifact[];
    readonly images: readonly NukeToolCallImage[];
    readonly errors: readonly string[];
    readonly rawText: readonly string[];
    readonly rawHtml: readonly NukeToolCallHtml[];
}

/** Longest value shown in the summary grid before an ellipsis is appended. */
export const MAX_SUMMARY_VALUE_LENGTH = 80;

/** Longest pretty-printed JSON detail string, in UTF-16 code units. */
export const MAX_JSON_DETAILS_LENGTH = 20 * 1024;

const MAX_SUMMARY_ENTRIES = 8;
const ELLIPSIS = '\u2026';
const CIRCULAR_MARKER = '[circular]';
const BINARY_MARKER = '[binary omitted]';

const TOOL_LABELS: Readonly<Record<string, string>> = {
    nuke_cad_summarizeDocument: 'CAD summary',
    nuke_cad_inspectSelection: 'CAD selection',
    nuke_cad_exportDagmc: 'DAGMC export',
    nuke_openmc_summarizeProject: 'OpenMC project',
    nuke_openmc_validateProject: 'OpenMC validation',
    nuke_openmc_importCad: 'DAGMC import',
    nuke_openmc_runSimulation: 'OpenMC run',
    nuke_openmc_getRunStatus: 'Run status',
    nuke_viz_summarizeStatepoint: 'Statepoint summary',
    nuke_viz_openStatepoint: 'Open statepoint',
    nuke_viz_captureView: 'Viewport capture'
};

/**
 * Parse a finished Nuke tool result into a card-friendly summary.
 *
 * The parser never throws. Text blocks that contain the bounded JSON envelope
 * written by `toToolCallContent` become structured data; every other text block
 * stays in {@link NukeToolCallSummary.rawText}. Error, image, and HTML blocks are
 * collected separately so the renderer never needs to inspect Theia internals.
 */
export function summarizeNukeToolResult(result: ToolCallResult): NukeToolCallSummary {
    const rawText: string[] = [];
    const errors: string[] = [];
    const images: NukeToolCallImage[] = [];
    const rawHtml: NukeToolCallHtml[] = [];
    const envelopes: Record<string, unknown>[] = [];
    let plainData: unknown;
    let hasPlainData = false;

    const absorbText = (text: string): void => {
        const envelope = envelopeFromText(text);
        if (envelope) {
            envelopes.push(envelope);
        } else {
            rawText.push(text);
        }
    };

    if (typeof result === 'string') {
        absorbText(result);
    } else if (isToolCallContent(result)) {
        collectContent(result, absorbText, errors, images, rawHtml);
    } else if (isRecord(result)) {
        const envelope = asEnvelope(result);
        if (envelope) {
            envelopes.push(envelope);
        } else {
            plainData = result;
            hasPlainData = true;
        }
    }

    const envelope = envelopes[0];
    const data = envelope && 'data' in envelope ? envelope.data : hasPlainData ? plainData : undefined;
    const ok = envelope && typeof envelope.ok === 'boolean' ? envelope.ok : undefined;
    const warnings = collectWarnings(envelope, data);
    const nextActions = normalizeNextActions(envelope?.nextActions);
    const artifacts = normalizeArtifacts(envelope?.artifacts);
    const message = firstNonEmpty(rawText) ?? envelopeMessage(envelope) ?? errors[0] ?? plainObjectMessage(plainData);

    return {
        ok,
        message,
        data,
        warnings,
        nextActions,
        artifacts,
        images,
        errors,
        rawText,
        rawHtml
    };
}

/** Map a Nuke tool name to a short card title. */
export function toolLabel(toolName: string): string {
    if (!toolName) {
        return 'Nuke tool';
    }
    const mapped = TOOL_LABELS[toolName];
    if (mapped) {
        return mapped;
    }
    const readable = toolName
        .replace(/^nuke[_.]/, '')
        .replace(/[_.]+/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .trim();
    if (!readable) {
        return toolName;
    }
    const capitalized = readable.charAt(0).toUpperCase() + readable.slice(1);
    return truncateSummaryValue(capitalized);
}

/**
 * Produce up to eight label/value pairs for a tool result payload.
 *
 * Known CAD, OpenMC, run-status, and statepoint fields come first. Primitive
 * top-level fields fill the remaining slots; nested objects and arrays of objects
 * are skipped so a large state object cannot flood the card.
 */
export function summaryEntries(data: unknown): NukeToolCallSummaryEntry[] {
    if (!isRecord(data)) {
        return [];
    }
    const entries: NukeToolCallSummaryEntry[] = [];
    const usedKeys = new Set<string>();
    // Warnings and the message have dedicated card sections; never repeat them in the grid.
    usedKeys.add('warnings');
    usedKeys.add('message');

    const add = (label: string, value: unknown, key?: string, pathValue = false): void => {
        if (entries.length >= MAX_SUMMARY_ENTRIES) {
            return;
        }
        const formatted = formatSummaryValue(value, pathValue);
        if (formatted === undefined) {
            return;
        }
        entries.push({ label, value: formatted });
        if (key !== undefined) {
            usedKeys.add(key);
        }
    };

    add('Document', data.documentPath, 'documentPath', true);
    add('Statepoint', data.file, 'file', true);
    add('Project', data.name, 'name');
    add('Project file', data.projectPath, 'projectPath', true);
    add('Valid', data.valid, 'valid');
    add('Build succeeded', data.success, 'success');
    add('Running', data.running, 'running');
    add('k-eff', data.kEff, 'kEff');
    add('k-eff uncertainty', data.kEffStd, 'kEffStd');
    add('Batches', data.batches, 'batches');
    add('Generations / batch', data.generationsPerBatch, 'generationsPerBatch');
    add('Tallies', data.nTallies, 'nTallies');
    add('Tally IDs', data.tallyIds, 'tallyIds');

    const counts = asRecord(data.counts);
    if (counts) {
        add('Surfaces', counts.surfaces);
        add('Cells', counts.cells);
        add('Universes', counts.universes);
        add('Lattices', counts.lattices);
        add('Materials', counts.materials);
        add('Tallies', counts.tallies);
        add('Meshes', counts.meshes);
    }

    add('Solids', data.solidCount, 'solidCount');
    add('Faces', data.faceCount, 'faceCount');
    add('Triangles', data.triangleCount, 'triangleCount');

    const summary = asRecord(data.summary);
    if (summary) {
        add('Errors', summary.errors);
        add('Warnings', summary.warnings);
        add('Info', summary.info);
    }
    add('Issues', data.issues, 'issues');

    add('Process ID', data.processId, 'processId');
    add('Run directory', data.workingDirectory, 'workingDirectory', true);
    add('Started', data.startTime, 'startTime');
    add('Log file', data.logFilePath, 'logFilePath', true);

    const selection = asRecord(data.selection);
    if (selection) {
        add('Selected solid', selection.solidId, 'selection');
        add('Selected face', selection.faceId);
    }

    add('DAGMC model', data.dagmcPath, 'dagmcPath', true);
    add('STEP model', data.stepPath, 'stepPath', true);
    add('Region manifest', data.regionManifestPath, 'regionManifestPath', true);
    add('Output directory', data.outputDirectory, 'outputDirectory', true);
    add('DAGMC file', data.dagmcFile, 'dagmcFile', true);
    add('Materials', data.materialNames, 'materialNames');
    add('Created materials', data.createdMaterials, 'createdMaterials');

    for (const [key, value] of Object.entries(data)) {
        if (entries.length >= MAX_SUMMARY_ENTRIES) {
            break;
        }
        if (usedKeys.has(key) || isNestedValue(value)) {
            continue;
        }
        add(humanizeKey(key), value);
    }
    return entries;
}

/**
 * Format a value as bounded, pretty-printed JSON for a raw details block.
 *
 * Circular references, big integers, errors, and binary buffers are converted
 * to readable markers instead of throwing. The returned string never exceeds
 * {@link MAX_JSON_DETAILS_LENGTH} code units plus the truncation suffix.
 */
export function formatJsonDetails(value: unknown): string {
    if (value === undefined) {
        return '';
    }
    let json: string;
    try {
        const serialized = JSON.stringify(toJsonSafe(value), undefined, 2);
        json = serialized ?? String(value);
    } catch {
        json = String(value);
    }
    if (json.length <= MAX_JSON_DETAILS_LENGTH) {
        return json;
    }
    return `${json.slice(0, MAX_JSON_DETAILS_LENGTH)}\n${ELLIPSIS} [truncated]`;
}

function collectContent(
    result: ToolCallContent,
    absorbText: (text: string) => void,
    errors: string[],
    images: NukeToolCallImage[],
    rawHtml: NukeToolCallHtml[]
): void {
    for (const block of result.content) {
        if (!block || typeof block !== 'object') {
            continue;
        }
        switch (block.type) {
            case 'text':
                if (typeof block.text === 'string') {
                    absorbText(block.text);
                }
                break;
            case 'error':
                if (typeof block.data === 'string') {
                    errors.push(block.data);
                }
                break;
            case 'image':
                if (typeof block.base64data === 'string' && typeof block.mimeType === 'string') {
                    images.push({
                        src: `data:${block.mimeType};base64,${block.base64data}`,
                        mimeType: block.mimeType,
                        alt: `Tool result image (${block.mimeType})`
                    });
                }
                break;
            case 'html':
                if (typeof block.html === 'string') {
                    rawHtml.push({ html: block.html, title: block.title ?? 'Tool result preview' });
                }
                break;
            default:
                break;
        }
    }
}

function envelopeFromText(text: string): Record<string, unknown> | undefined {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
        return undefined;
    }
    try {
        return asEnvelope(JSON.parse(trimmed));
    } catch {
        return undefined;
    }
}

function asEnvelope(value: unknown): Record<string, unknown> | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const hasEnvelopeField =
        typeof value.ok === 'boolean' ||
        'data' in value ||
        'warnings' in value ||
        'nextActions' in value ||
        'artifacts' in value ||
        'handle' in value;
    return hasEnvelopeField ? value : undefined;
}

function envelopeMessage(envelope: Record<string, unknown> | undefined): string | undefined {
    return envelope && typeof envelope.message === 'string' && envelope.message.trim().length > 0 ? envelope.message : undefined;
}

function plainObjectMessage(data: unknown): string | undefined {
    return isRecord(data) && typeof data.message === 'string' && data.message.trim().length > 0 ? data.message : undefined;
}

function collectWarnings(envelope: Record<string, unknown> | undefined, data: unknown): string[] {
    const warnings = stringEntries(envelope?.warnings);
    if (warnings.length === 0 && isRecord(data)) {
        warnings.push(...stringEntries(data.warnings));
    }
    return warnings;
}

function normalizeNextActions(value: unknown): NukeToolCallNextAction[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const actions: NukeToolCallNextAction[] = [];
    for (const entry of value) {
        if (!isRecord(entry)) {
            continue;
        }
        const capability = typeof entry.capability === 'string' ? entry.capability : '';
        const reason = typeof entry.reason === 'string' ? entry.reason : '';
        if (capability.length > 0 || reason.length > 0) {
            actions.push({ capability, reason });
        }
    }
    return actions;
}

function normalizeArtifacts(value: unknown): NukeToolCallArtifact[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const artifacts: NukeToolCallArtifact[] = [];
    for (const entry of value) {
        if (!isRecord(entry)) {
            continue;
        }
        const path = typeof entry.path === 'string' ? entry.path : undefined;
        const uri = typeof entry.uri === 'string' ? entry.uri : undefined;
        const label = typeof entry.label === 'string' ? entry.label : (path ?? uri ?? 'Artifact');
        artifacts.push({
            kind: typeof entry.kind === 'string' ? entry.kind : undefined,
            label,
            path,
            uri
        });
    }
    return artifacts;
}

function stringEntries(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function firstNonEmpty(values: readonly string[]): string | undefined {
    return values.find((value) => value.trim().length > 0);
}

function formatSummaryValue(value: unknown, pathValue: boolean): string | undefined {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed.length === 0) {
            return 'None';
        }
        return truncateSummaryValue(pathValue ? shortenPath(trimmed) : trimmed);
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? truncateSummaryValue(String(value)) : undefined;
    }
    if (typeof value === 'boolean') {
        return value ? 'Yes' : 'No';
    }
    if (Array.isArray(value)) {
        if (value.length === 0) {
            return undefined;
        }
        if (value.every((entry) => entry === null || ['string', 'number', 'boolean'].includes(typeof entry))) {
            const joined = value.map((entry) => (entry === null ? 'null' : String(entry))).join(', ');
            return truncateSummaryValue(joined);
        }
        const noun = value.length === 1 ? 'item' : 'items';
        return `${value.length} ${noun}`;
    }
    return undefined;
}

function truncateSummaryValue(value: string): string {
    if (value.length <= MAX_SUMMARY_VALUE_LENGTH) {
        return value;
    }
    return `${value.slice(0, MAX_SUMMARY_VALUE_LENGTH - 1)}${ELLIPSIS}`;
}

function shortenPath(value: string): string {
    const segments = value
        .replace(/\\/g, '/')
        .split('/')
        .filter((segment) => segment.length > 0);
    if (segments.length <= 3) {
        return value;
    }
    return `${ELLIPSIS}/${segments.slice(-2).join('/')}`;
}

function humanizeKey(key: string): string {
    const words = key
        .replace(/[_-]+/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .trim();
    if (!words) {
        return key;
    }
    const normalized = words.toLowerCase();
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function isNestedValue(value: unknown): boolean {
    return (
        value !== null &&
        typeof value === 'object' &&
        (Array.isArray(value) ? value.some((entry) => entry !== null && typeof entry === 'object') : true)
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return isRecord(value) ? value : undefined;
}

function toJsonSafe(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
    if (value === null) {
        return null;
    }
    switch (typeof value) {
        case 'string':
        case 'boolean':
            return value;
        case 'number':
            return Number.isFinite(value) ? value : String(value);
        case 'bigint':
            return value.toString();
        case 'undefined':
        case 'function':
        case 'symbol':
            return undefined;
        default:
            break;
    }
    if (typeof value !== 'object') {
        return undefined;
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (value instanceof Error) {
        return { name: value.name, message: value.message };
    }
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        return BINARY_MARKER;
    }
    if (seen.has(value)) {
        return CIRCULAR_MARKER;
    }
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            return value.map((entry) => toJsonSafe(entry, seen));
        }
        const serialized: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value)) {
            const normalized = toJsonSafe(entry, seen);
            if (normalized !== undefined) {
                serialized[key] = normalized;
            }
        }
        return serialized;
    } finally {
        seen.delete(value);
    }
}
