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

import { describe, expect, it } from 'vitest';
import type { RecommendedAgent } from '@theia/ai-chat/lib/common/chat-agent-recommendation-service';
import { mergeRecommendedAgents, NUKE_RECOMMENDED_AGENTS } from './nuke-agent-recommendations';

const upstream: RecommendedAgent[] = [
    { id: 'Coder', label: 'Coder' },
    { id: 'Architect', label: 'Architect' },
    { id: 'Universal', label: 'Universal' }
];

describe('mergeRecommendedAgents', () => {
    it('puts NukeAI and Nuke Diagnostics first and keeps upstream recommendations', () => {
        const merged = mergeRecommendedAgents(NUKE_RECOMMENDED_AGENTS, upstream, () => true);

        expect(merged.map((agent) => agent.id)).toEqual(['NukeAI', 'NukeDiagnostics', 'Coder', 'Architect', 'Universal']);
    });

    it('filters agents that are not registered', () => {
        const available = new Set(['NukeAI', 'Universal']);
        const merged = mergeRecommendedAgents(NUKE_RECOMMENDED_AGENTS, upstream, (id) => available.has(id));

        expect(merged.map((agent) => agent.id)).toEqual(['NukeAI', 'Universal']);
    });

    it('keeps the product label when an upstream recommendation reuses the id', () => {
        const merged = mergeRecommendedAgents(
            NUKE_RECOMMENDED_AGENTS,
            [{ id: 'NukeAI', label: 'Upstream NukeAI' }, ...upstream],
            () => true
        );

        expect(merged.find((agent) => agent.id === 'NukeAI')?.label).toBe('NukeAI');
    });
});
