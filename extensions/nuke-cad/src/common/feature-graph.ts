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
 * Feature dependency DAG and partial recompute planner.
 *
 * The graph is built from explicit `dependsOn` edges only; sketch dependencies
 * are resolved by the caller before constructing the graph. This is the
 * FreeCAD-style recompute engine foundation described in the nuke-cad program
 * the feature-graph contract.
 *
 * @module nuke-cad/common
 */

import type { FeatureDef } from './cad-document';

/** Status a build executor may assign to a plan entry. */
export type RecomputeStatus = 'pending' | 'success' | 'failed' | 'stale';

/** A single entry in the recompute plan. */
export interface RecomputePlanEntry {
    featureId: string;
    status: RecomputeStatus;
}

/** Result of {@link FeatureGraph.recomputePlan}. */
export interface RecomputePlan {
    /** Feature ids in topological build order. */
    order: string[];
    /** Per-entry status initialized to 'pending'. */
    entries: RecomputePlanEntry[];
    /** Ids of features whose shape is already known to be stale. */
    stale: string[];
}

/** Dependency graph over feature ids. */
export class FeatureGraph {
    private readonly features = new Map<string, FeatureDef>();
    private readonly dependencies = new Map<string, string[]>();
    private readonly dependents = new Map<string, string[]>();
    private dirty = new Set<string>();

    constructor(features: FeatureDef[]) {
        for (const feature of features) {
            if (this.features.has(feature.id)) {
                throw new Error(`Duplicate feature id '${feature.id}' in feature graph`);
            }
            this.features.set(feature.id, feature);
            this.dependencies.set(feature.id, [...feature.dependsOn]);
            this.dependents.set(feature.id, []);
        }
        for (const feature of features) {
            for (const dep of feature.dependsOn) {
                if (!this.features.has(dep)) {
                    throw new Error(`Feature '${feature.id}' depends on unknown feature '${dep}'`);
                }
                this.dependents.get(dep)!.push(feature.id);
            }
        }
    }

    /** Return all feature ids in topological order (dependencies first). */
    topologicalOrder(): string[] {
        return this.topologicalSortInternal(this.features.keys());
    }

    /** Mark one or more features as dirty. */
    markDirty(featureIds: string[]): void {
        for (const id of featureIds) {
            if (!this.features.has(id)) {
                throw new Error(`Cannot mark unknown feature '${id}' as dirty`);
            }
            this.dirty.add(id);
        }
    }

    /** Mark one or more features as clean, removing them from the dirty set. */
    markClean(featureIds: string[]): void {
        for (const id of featureIds) {
            if (!this.features.has(id)) {
                throw new Error(`Cannot mark unknown feature '${id}' as clean`);
            }
            this.dirty.delete(id);
        }
    }

    /**
     * Build a minimal recompute plan.
     *
     * Intended caller workflow:
     *   1. Call {@link markDirty} when an edit invalidates one or more features.
     *   2. Call {@link recomputePlan} to obtain the affected features in build
     *      order (dependencies first).
     *   3. Execute the plan and rebuild each feature.
     *   4. Call {@link markClean} for the features that rebuilt successfully so
     *      the next plan starts from the updated state. Features that failed
     *      should stay dirty so they are retried on the next recompute.
     *
     * Includes all dirty features and every transitive dependent, ordered so
     * that each feature appears after its dependencies. Suppressed features are
     * omitted and any non-suppressed feature that depends on a suppressed
     * feature is recorded as stale.
     */
    recomputePlan(): RecomputePlan {
        const affected = new Set<string>();
        const visit = (id: string): void => {
            if (affected.has(id)) {
                return;
            }
            affected.add(id);
            for (const dependent of this.dependents.get(id) ?? []) {
                visit(dependent);
            }
        };
        for (const id of this.dirty) {
            visit(id);
        }

        const suppressed = new Set<string>();
        const stale = new Set<string>();
        for (const id of affected) {
            if (this.features.get(id)?.suppressed) {
                suppressed.add(id);
            }
        }
        // Propagate staleness through dependents of suppressed features.
        const markStale = (id: string): void => {
            for (const dependent of this.dependents.get(id) ?? []) {
                if (!this.features.get(dependent)?.suppressed && !stale.has(dependent)) {
                    stale.add(dependent);
                    markStale(dependent);
                }
            }
        };
        for (const id of suppressed) {
            markStale(id);
        }

        const active = new Set<string>();
        for (const id of affected) {
            if (!suppressed.has(id) && !stale.has(id)) {
                active.add(id);
            }
        }

        const order = this.topologicalSortInternal(active);
        const entries = order.map((featureId) => ({ featureId, status: 'pending' as RecomputeStatus }));
        return { order, entries, stale: [...stale] };
    }

    private topologicalSortInternal(ids: Iterable<string>): string[] {
        const idList = [...ids];
        const indexOf = new Map<string, number>();
        for (let i = 0; i < idList.length; i++) {
            indexOf.set(idList[i], i);
        }
        const inDegree = new Map<string, number>();
        for (const id of idList) {
            inDegree.set(id, 0);
        }
        for (const id of idList) {
            for (const dep of this.dependencies.get(id) ?? []) {
                if (inDegree.has(dep)) {
                    inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
                }
            }
        }

        const queue: string[] = [];
        for (const [id, degree] of inDegree.entries()) {
            if (degree === 0) {
                queue.push(id);
            }
        }

        const sorted: string[] = [];
        while (queue.length > 0) {
            // Document-order tiebreak: always expand the earliest feature in the
            // supplied list among the current zero-in-degree ids.
            queue.sort((a, b) => (indexOf.get(a) ?? 0) - (indexOf.get(b) ?? 0));
            const id = queue.shift()!;
            sorted.push(id);
            for (const dependent of this.dependents.get(id) ?? []) {
                if (!inDegree.has(dependent)) {
                    continue;
                }
                const next = (inDegree.get(dependent) ?? 0) - 1;
                inDegree.set(dependent, next);
                if (next === 0) {
                    queue.push(dependent);
                }
            }
        }

        if (sorted.length !== inDegree.size) {
            const cycle = this.findCycle();
            throw new Error(`Feature dependency cycle detected: ${cycle.join(' -> ')}`);
        }

        return sorted;
    }

    private findCycle(): string[] {
        const state = new Map<string, 'unvisited' | 'visiting' | 'visited'>();
        for (const id of this.features.keys()) {
            state.set(id, 'unvisited');
        }
        const path: string[] = [];

        const dfs = (id: string): string[] | undefined => {
            state.set(id, 'visiting');
            path.push(id);
            for (const dep of this.dependencies.get(id) ?? []) {
                if (state.get(dep) === 'visiting') {
                    const start = path.indexOf(dep);
                    return [...path.slice(start), dep];
                }
                if (state.get(dep) === 'unvisited') {
                    const cycle = dfs(dep);
                    if (cycle) {
                        return cycle;
                    }
                }
            }
            path.pop();
            state.set(id, 'visited');
            return undefined;
        };

        for (const id of this.features.keys()) {
            if (state.get(id) === 'unvisited') {
                const cycle = dfs(id);
                if (cycle) {
                    return cycle;
                    // eslint-disable-next-line no-unreachable
                }
            }
        }
        return [];
    }
}
