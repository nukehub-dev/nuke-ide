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
 * Nuke agent recommendations for the chat welcome screen. NukeAI and Nuke
 * Diagnostics lead the list; Theia's recommendations follow without replacing
 * them. Unregistered agents are filtered out so the picker never offers an
 * agent that cannot handle a message.
 *
 * @module nuke-ai/browser/welcome
 */

import type { RecommendedAgent } from '@theia/ai-chat/lib/common/chat-agent-recommendation-service';
import { NUKE_CHAT_AGENT_ID } from '../agent/nuke-chat-agent';
import { NUKE_DIAGNOSTICS_AGENT_ID } from '../agent/nuke-diagnostics-agent';

/** Product agents shown before Theia's general-purpose recommendations. */
export const NUKE_RECOMMENDED_AGENTS: readonly RecommendedAgent[] = [
    {
        id: NUKE_CHAT_AGENT_ID,
        label: 'NukeAI',
        description: 'Nuclear engineering assistant for CAD, OpenMC, and statepoint workflows.'
    },
    {
        id: NUKE_DIAGNOSTICS_AGENT_ID,
        label: 'Nuke Diagnostics',
        description: 'Read-only diagnostics for the active CAD model, OpenMC project, run, and statepoint.'
    }
];

/**
 * Merge product and upstream recommendations, preserving the first occurrence
 * of each id and dropping agents that are not registered.
 */
export function mergeRecommendedAgents(
    primary: readonly RecommendedAgent[],
    recommended: readonly RecommendedAgent[],
    isAvailable: (id: string) => boolean
): RecommendedAgent[] {
    const merged = new Map<string, RecommendedAgent>();
    for (const agent of [...primary, ...recommended]) {
        if (!merged.has(agent.id) && isAvailable(agent.id)) {
            merged.set(agent.id, agent);
        }
    }
    return [...merged.values()];
}
