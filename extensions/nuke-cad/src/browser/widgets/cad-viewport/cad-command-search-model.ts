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
 * Pure model for the CAD document-toolbar command search (no DOM, no React).
 *
 * The host maps the shared `buildCadCommands` specs into
 * `CadCommandSearchAction` entries; this module only filters that list.
 *
 * @module nuke-cad/browser/widgets/cad-viewport
 */

/** One searchable command flattened from the document command registry. */
export interface CadCommandSearchAction {
    readonly id: string;
    readonly label: string;
    readonly shortLabel?: string;
    readonly icon: string;
    readonly disabled?: boolean;
    /** Concise explanation shown on a disabled row; never runs the action. */
    readonly disabledReason?: string;
    /** Section caption the action lives in (`Document`, `Additive`, …). */
    readonly group: string;
    readonly onClick: () => void;
}

/** Maximum rows shown for one query (the popover scrolls beyond the cap). */
export const CAD_COMMAND_SEARCH_MAX_RESULTS = 12;

/**
 * Case-insensitive substring match over the full label, the tile short label,
 * and the section caption. An empty/blank query returns the first
 * {@link CAD_COMMAND_SEARCH_MAX_RESULTS} actions in ribbon order.
 */
export function filterCadCommandActions(actions: readonly CadCommandSearchAction[], query: string): readonly CadCommandSearchAction[] {
    const needle = query.trim().toLowerCase();
    const matches =
        needle === ''
            ? actions
            : actions.filter((action) =>
                  [action.label, action.shortLabel ?? '', action.group].some((text) => text.toLowerCase().includes(needle))
              );
    return matches.slice(0, CAD_COMMAND_SEARCH_MAX_RESULTS);
}
