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
 * Pure comparison-session model for the Comparison workspace.
 *
 * A session is an ordered, deduplicated set of open native viewers (panes)
 * labelled A, B, C, ... Each pane optionally joins the session's shared color
 * range: every pane publishes its active array's data range under
 * `(sessionId, viewId)`, and the bus hands every listener the union of the
 * published data ranges. Sharing the union (never a pane's effective/custom
 * range) keeps publishing acyclic: applying the union cannot change the data
 * ranges that produced it.
 *
 * The bus mirrors `camera-link-bus.ts`: publish/dispose endpoints, defensive
 * copies at every boundary, and listeners notified only when the union
 * actually changes, so an unchanged republish terminates instead of looping.
 * Sessions are isolated; a session's state is dropped once its last listener
 * and range are gone. Unlike the camera bus, every listener — the publisher
 * included — receives the new union, because the publisher's own range is
 * part of what changed.
 *
 * Pure functions + types only; no DOM, no three.js, no Theia imports.
 */

/** Inclusive scalar range of one pane's active color-by array. */
export type ComparisonRange = readonly [number, number];

/** Per-pane comparison options applied by `joinComparison`. */
export interface ComparisonViewOptions {
    readonly sessionId: string;
    readonly label: string;
    readonly linkCameras: boolean;
    readonly sharedRange: boolean;
    readonly showLabels: boolean;
}

/** One pane of a comparison session (label follows pane order). */
export interface ComparisonPane {
    readonly viewId: string;
    readonly label: string;
    readonly title: string;
}

/** A comparison session: its shared id plus panes in input order. */
export interface ComparisonSession {
    readonly id: string;
    readonly panes: readonly ComparisonPane[];
}

/**
 * Structural contract shared by every widget that can join a comparison:
 * the generic native viewer and the DAGMC viewer implement it. Kept free of
 * Theia/three.js types so command filtering and tests stay pure.
 */
export interface ComparisonViewHost {
    readonly id: string;
    joinComparison(options: ComparisonViewOptions): void;
    leaveComparison(): void;
    getComparisonView(): ComparisonViewOptions | undefined;
    syncComparisonCamera(): void;
}

/** Duck-typed host check for command filtering (no widget imports). */
export function isComparisonViewHost(value: unknown): value is ComparisonViewHost {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const host = value as Partial<ComparisonViewHost>;
    return (
        typeof host.id === 'string' &&
        typeof host.joinComparison === 'function' &&
        typeof host.leaveComparison === 'function' &&
        typeof host.getComparisonView === 'function' &&
        typeof host.syncComparisonCamera === 'function'
    );
}

/** First pane label (`A`). */
const FIRST_LABEL_CODE = 'A'.charCodeAt(0);

/** Number of single-letter labels (`A`–`Z`); beyond this, labels become `P<n>`. */
const LETTER_LABEL_COUNT = 26;

/**
 * Pane label for a zero-based index: `A`–`Z`, then `P27`, `P28`, ...
 * Fractional/negative/non-finite indices clamp to a real pane slot so a
 * malformed caller still gets a stable label instead of a throw.
 */
export function comparisonViewLabel(index: number): string {
    const slot = Number.isFinite(index) && index > 0 ? Math.floor(index) : 0;
    return slot < LETTER_LABEL_COUNT ? String.fromCharCode(FIRST_LABEL_CODE + slot) : `P${slot + 1}`;
}

/**
 * Build a session from the selected viewers. Input order is pane order, a
 * repeated `viewId` is dropped, empty view ids are dropped, and a blank title
 * falls back to `View <label>`.
 */
export function createComparisonSession(
    id: string,
    views: readonly { readonly viewId: string; readonly title: string }[]
): ComparisonSession {
    const seen = new Set<string>();
    const panes: ComparisonPane[] = [];
    for (const view of views) {
        if (!view.viewId || seen.has(view.viewId)) {
            continue;
        }
        seen.add(view.viewId);
        const label = comparisonViewLabel(panes.length);
        const title = view.title.trim();
        panes.push({ viewId: view.viewId, label, title: title.length > 0 ? title : `View ${label}` });
    }
    return { id, panes };
}

/**
 * Normalize one candidate range: exactly two finite, ascending endpoints.
 * Anything else (non-finite, inverted, wrong shape) carries no range.
 */
function readComparisonRange(value: unknown): ComparisonRange | undefined {
    if (!Array.isArray(value) || value.length !== 2) {
        return undefined;
    }
    const min = value[0];
    const max = value[1];
    if (typeof min !== 'number' || typeof max !== 'number' || !Number.isFinite(min) || !Number.isFinite(max) || min > max) {
        return undefined;
    }
    return [min, max];
}

/**
 * Union of the usable ranges: the smallest minimum paired with the largest
 * maximum. Non-finite and inverted ranges are skipped; `undefined` when no
 * usable range remains. The result is a fresh tuple.
 */
export function comparisonRangeUnion(ranges: Iterable<ComparisonRange | undefined>): ComparisonRange | undefined {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let found = false;
    for (const range of ranges) {
        const normalized = readComparisonRange(range);
        if (!normalized) {
            continue;
        }
        found = true;
        if (normalized[0] < min) {
            min = normalized[0];
        }
        if (normalized[1] > max) {
            max = normalized[1];
        }
    }
    return found ? [min, max] : undefined;
}

/** Camera-link key shared by every pane of one comparison session. */
export function comparisonCameraKey(sessionId: string): string {
    return `comparison:${sessionId}`;
}

/** Receiver for the session's shared range (undefined when no pane has one). */
export type ComparisonRangeListener = (range: ComparisonRange | undefined) => void;

/** One linked pane: publish its data range, dispose to leave the session. */
export interface ComparisonRangeEndpoint {
    /** Add/replace this view's range; an undefined/invalid range removes it. */
    publish(range: ComparisonRange | undefined): void;
    /** Remove this view's range and listener, then notify the remaining listeners. */
    dispose(): void;
}

/** Shared-range bus scoped per session. */
export interface ComparisonRangeBus {
    /** Join one pane's view to its session; the listener is called immediately with the current union. */
    link(sessionId: string, viewId: string, listener: ComparisonRangeListener): ComparisonRangeEndpoint;
    /** Current union for a session (defensive copy), or undefined. */
    union(sessionId: string): ComparisonRange | undefined;
}

interface ComparisonRangeSessionState {
    readonly ranges: Map<string, ComparisonRange>;
    readonly listeners: Map<number, ComparisonRangeListener>;
    union: ComparisonRange | undefined;
    /** Bumped on every dispatch so a nested change can abandon a stale one. */
    revision: number;
}

/** Defensive copy (stored/listener ranges must not alias caller memory). */
function copyComparisonRange(range: ComparisonRange): ComparisonRange {
    return [range[0], range[1]];
}

/** Exact tuple equality (the change-detection comparison). */
function comparisonRangesEqual(a: ComparisonRange | undefined, b: ComparisonRange | undefined): boolean {
    if (a === undefined || b === undefined) {
        return a === b;
    }
    return a[0] === b[0] && a[1] === b[1];
}

/** Create an isolated bus (widgets share {@link comparisonRangeBus} instead). */
export function createComparisonRangeBus(): ComparisonRangeBus {
    let nextListenerId = 1;
    const sessions = new Map<string, ComparisonRangeSessionState>();

    /**
     * Recompute the session union and notify every listener when it changed.
     * Membership is snapshotted so listeners may link/dispose mid-dispatch;
     * a nested change (revision bump) abandons the stale outer dispatch.
     */
    function dispatch(session: ComparisonRangeSessionState): void {
        const union = comparisonRangeUnion(session.ranges.values());
        if (comparisonRangesEqual(union, session.union)) {
            return;
        }
        session.union = union;
        const revision = ++session.revision;
        for (const [id, listener] of [...session.listeners]) {
            if (session.revision !== revision) {
                return;
            }
            if (session.listeners.get(id) === listener) {
                listener(union ? copyComparisonRange(union) : undefined);
            }
        }
    }

    return {
        link: (sessionId: string, viewId: string, listener: ComparisonRangeListener): ComparisonRangeEndpoint => {
            // Without a session identity there is nothing to scope to: hand
            // out an inert endpoint rather than a shared/global range.
            if (!sessionId) {
                return { publish: () => undefined, dispose: () => undefined };
            }
            const existing = sessions.get(sessionId);
            const session: ComparisonRangeSessionState = existing ?? {
                ranges: new Map(),
                listeners: new Map(),
                union: undefined,
                revision: 0
            };
            if (!existing) {
                sessions.set(sessionId, session);
            }
            const id = nextListenerId++;
            session.listeners.set(id, listener);
            // Initial call: the joining pane immediately learns the union.
            listener(session.union ? copyComparisonRange(session.union) : undefined);
            let disposed = false;
            return {
                publish: (range: ComparisonRange | undefined): void => {
                    if (disposed) {
                        return;
                    }
                    const normalized = readComparisonRange(range);
                    if (normalized) {
                        session.ranges.set(viewId, normalized);
                    } else {
                        session.ranges.delete(viewId);
                    }
                    dispatch(session);
                },
                dispose: (): void => {
                    if (disposed) {
                        return;
                    }
                    disposed = true;
                    session.listeners.delete(id);
                    session.ranges.delete(viewId);
                    dispatch(session);
                    if (session.listeners.size === 0 && session.ranges.size === 0) {
                        sessions.delete(sessionId);
                    }
                }
            };
        },
        union: (sessionId: string): ComparisonRange | undefined => {
            const session = sessions.get(sessionId);
            return session?.union ? copyComparisonRange(session.union) : undefined;
        }
    };
}

/** Shared bus for the native viewers (one process, one comparison scope). */
export const comparisonRangeBus: ComparisonRangeBus = createComparisonRangeBus();
