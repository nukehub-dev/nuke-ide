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
 * NukeAI action groups for the Simulation dashboard's validation and run
 * controls. Domain-neutral: reads `openmc.validation` / `openmc.run`
 * descriptors from the nuke-core registry and omits actions whose Theia
 * command is not installed (an exclusion build without NukeAI).
 *
 * @module openmc-studio/browser/widgets/simulation-dashboard
 */

import type { CommandRegistry } from '@theia/core/lib/common/command';
import type {
    NukeContextAction,
    NukeContextActionRegistry,
    NukeContextActionScope
} from 'nuke-core/lib/common/nuke-context-action-protocol';

/** One rendered NukeAI toolbar group. */
export interface OpenMcNukeAiGroup {
    readonly id: 'validation' | 'run';
    readonly label: string;
    readonly scope: NukeContextActionScope;
    readonly actions: readonly NukeContextAction[];
}

/** Dashboard surfaces that host NukeAI actions, in display order. */
export const OPENMC_NUKE_AI_GROUPS: readonly Omit<OpenMcNukeAiGroup, 'actions'>[] = [
    { id: 'validation', label: 'NukeAI · Validation', scope: 'openmc.validation' },
    { id: 'run', label: 'NukeAI · Run', scope: 'openmc.run' }
];

/**
 * Build the enabled groups. A group disappears when it has no action left,
 * so the toolbar never renders an empty header.
 */
export function buildOpenMcNukeAiGroups(
    registry: Pick<NukeContextActionRegistry, 'getActions'>,
    commands: Pick<CommandRegistry, 'getCommand'>
): OpenMcNukeAiGroup[] {
    return OPENMC_NUKE_AI_GROUPS.map((group) => ({
        ...group,
        actions: registry.getActions(group.scope).filter((action) => commands.getCommand(action.commandId) !== undefined)
    })).filter((group) => group.actions.length > 0);
}
