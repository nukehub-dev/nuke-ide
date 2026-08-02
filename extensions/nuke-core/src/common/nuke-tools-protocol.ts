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
 * Contract for contributing items to the Nuke Tools sidebar.
 *
 * Extensions register a {@link NukeToolsContribution} to declare categorized,
// searchable tool entries. The sidebar widget collects every contribution and
// renders them in a single, consistent panel.
 *
 * @module nuke-core/common
 */

import { MaybePromise } from '@theia/core/lib/common/types';

/**
 * A single entry shown in the Nuke Tools sidebar.
 */
export interface NukeToolsItem {
    /** Stable identifier, unique within the contributing extension. */
    id: string;

    /** Human-readable label rendered in the sidebar. */
    label: string;

    /** Theia command identifier executed when the item is clicked. */
    commandId: string;

    /** Category path used to group items. The first element is the top-level section. */
    category: string[];

    /** Lexicographic ordering within the deepest category. */
    order?: string;

    /** Codicon class (e.g. `codicon-play-circle`) for the item row. */
    icon?: string;

    /** Optional longer description shown as a tooltip. */
    description?: string;

    /** Optional search keywords in addition to label and description. */
    keywords?: string[];
}

/**
 * Registry passed to contributions so they can register {@link NukeToolsItem}s.
 */
export interface NukeToolsRegistry {
    /**
     * Register a tool item in the sidebar.
     *
     * @param item - The item to register.
     */
    registerItem(item: NukeToolsItem): void;
}

/**
 * Contribution point for adding entries to the Nuke Tools sidebar.
 *
 * Extensions implement this interface and bind it to the
 * {@link NukeToolsContribution} contribution provider. The sidebar widget
 * resolves all contributions at startup and merges their items.
 */
export interface NukeToolsContribution {
    /**
     * Register tool items with the given registry.
     *
     * @param registry - The registry to populate.
     * @returns A promise or void.
     */
    registerTools(registry: NukeToolsRegistry): MaybePromise<void>;
}

/**
 * DI symbol for the {@link NukeToolsContribution} provider.
 */
export const NukeToolsContribution = Symbol('NukeToolsContribution');
