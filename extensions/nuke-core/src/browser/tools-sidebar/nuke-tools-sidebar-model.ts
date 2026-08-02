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
 * Pure data helpers for the Nuke Tools sidebar.
 *
 * Kept separate from the React widget so the logic can be unit-tested
 * without a DOM environment.
 *
 * @module nuke-core/browser/tools-sidebar
 */

import { NukeToolsItem } from '../../common/nuke-tools-protocol';

/** Composite key used for grouping. */
export type CategoryKey = string;

/** A grouped category with its visible items and nested subcategories. */
export interface NukeToolsCategory {
    label: string;
    items: NukeToolsItem[];
    subcategories: Map<CategoryKey, NukeToolsCategory>;
    order?: string;
}

/**
 * Sort items by category path then by order/label.
 *
 * @param items - Items to sort (mutated in place).
 * @returns The sorted array.
 */
export function sortItems(items: NukeToolsItem[]): NukeToolsItem[] {
    return items.sort((a, b) => {
        const categoryCompare = JSON.stringify(a.category).localeCompare(JSON.stringify(b.category));
        if (categoryCompare !== 0) {
            return categoryCompare;
        }
        const orderA = a.order ?? a.label;
        const orderB = b.order ?? b.label;
        return orderA.localeCompare(orderB);
    });
}

/**
 * Check whether an item matches the given search query.
 *
 * @param item - Item to test.
 * @param query - Lowercase query string.
 * @returns True if the item matches.
 */
export function matchesQuery(item: NukeToolsItem, query: string): boolean {
    const normalizedQuery = query.toLowerCase();
    const haystack = [item.label, item.description ?? '', ...(item.keywords ?? []), ...item.category].join(' ').toLowerCase();
    return haystack.includes(normalizedQuery);
}

/**
 * Group items into a nested category tree, optionally filtering by query.
 *
 * Items are placed at the deepest category level specified by their
 * {@link NukeToolsItem.category} path. Intermediate nodes contain no items.
 *
 * @param items - All registered items.
 * @param query - Optional lowercase search query.
 * @returns A map from top-level category key to category data, in insertion order.
 */
export function groupItems(items: NukeToolsItem[], query?: string): Map<CategoryKey, NukeToolsCategory> {
    const groups = new Map<CategoryKey, NukeToolsCategory>();
    const normalizedQuery = query?.trim().toLowerCase();

    for (const item of items) {
        if (normalizedQuery && !matchesQuery(item, normalizedQuery)) {
            continue;
        }

        const path = item.category.length > 0 ? item.category : ['Other'];
        let currentMap = groups;
        for (let i = 0; i < path.length; i++) {
            const label = path[i];
            const key = label.toLowerCase();
            if (!currentMap.has(key)) {
                const order = i === 0 ? item.sectionOrder : i === path.length - 1 ? item.categoryOrder : undefined;
                currentMap.set(key, { label, items: [], subcategories: new Map(), order });
            }
            const category = currentMap.get(key)!;
            if (category.order === undefined) {
                const fallbackOrder = i === 0 ? item.sectionOrder : i === path.length - 1 ? item.categoryOrder : undefined;
                if (fallbackOrder !== undefined) {
                    category.order = fallbackOrder;
                }
            }
            if (i === path.length - 1) {
                category.items.push(item);
            } else {
                currentMap = category.subcategories;
            }
        }
    }

    return groups;
}
