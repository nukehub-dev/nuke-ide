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
 * Tally viewer NukeAI context-menu rows.
 *
 * The tally scope only exists when a tally dataset is loaded, so the builder
 * takes that state explicitly instead of exposing the group on empty viewers.
 * Pure and vitest-covered; the widget routes the returned ids back to the
 * neutral context-action commands.
 *
 * @module nuke-visualizer/browser/plugins/openmc/widgets/tally-native
 */

import type { NukeContextAction } from 'nuke-core/lib/common/nuke-context-action-protocol';
import type { ViewerContextMenuItem } from '../../../../viewer-core/viewer-context-menu';

/** Id prefix that routes a row to the neutral context-action command. */
export const TALLY_CONTEXT_ACTION_MENU_PREFIX = 'nuke-ai:';

/** Stable menu id for one tally context action. */
export function tallyContextActionMenuId(action: NukeContextAction): string {
    return `${TALLY_CONTEXT_ACTION_MENU_PREFIX}${action.id}`;
}

/**
 * Rows for the tally NukeAI group. `hasLoadedTally` must be true (a parsed
 * dataset exists); otherwise the group is omitted entirely.
 */
export function buildTallyContextActionsMenuItems(hasLoadedTally: boolean, actions: readonly NukeContextAction[]): ViewerContextMenuItem[] {
    if (!hasLoadedTally) {
        return [];
    }
    return actions.map((action, index) => ({
        id: tallyContextActionMenuId(action),
        label: action.label,
        icon: 'codicon-beaker',
        separatorAbove: index === 0 ? true : undefined
    }));
}
