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

import { describe, expect, it, vi } from 'vitest';

vi.mock('@theia/ai-ide/lib/browser/ai-getting-started-walkthrough', () => ({ AiGettingStartedWalkthroughProvider: class {} }));
vi.mock('@theia/ai-core/lib/browser/ai-activation-service', () => ({ ENABLE_AI_CONTEXT_KEY: 'aiFeatures.enabled' }));
vi.mock('@theia/core/lib/browser/frontend-application-config-provider', () => ({
    FrontendApplicationConfigProvider: { get: () => ({ applicationName: 'NukeIDE' }) }
}));

import type { AiGettingStartedWalkthroughProvider } from '@theia/ai-ide/lib/browser/ai-getting-started-walkthrough';
import type { WalkthroughDefinition } from '@theia/getting-started/lib/common/walkthrough-types';
import { NukeAiWalkthroughProvider, NUKE_AI_GUIDE_LINK } from './nuke-ai-walkthrough-provider';

const THEIA_DOC = 'https://theia-ide.org/docs/user_ai/';

/** Base definition shaped like Theia's AI walkthrough. */
function baseWalkthrough(): WalkthroughDefinition {
    return {
        id: 'ai-features.getting-started',
        icon: 'sparkle',
        title: 'Get started with AI',
        description: 'Set up the AI features of NukeIDE and learn how to work with them.',
        steps: [
            {
                id: 'ai-support',
                title: 'AI support in NukeIDE',
                description: `NukeIDE comes with AI support.\n\nAll of this is built on Theia AI. [Read the framework documentation](https://theia-ide.org/docs/theia_ai/).`,
                completionEvents: ['onContext:aiFeatures.enabled', `onLink:${THEIA_DOC}`]
            },
            {
                id: 'connect-model',
                title: 'Connect a language model',
                description: 'Add an API key.'
            },
            {
                id: 'go-further',
                title: 'Go further',
                description: `There is more in [the documentation](${THEIA_DOC}) - and your feedback is always welcome.`
            }
        ]
    };
}

function provider(): NukeAiWalkthroughProvider {
    const base = { getWalkthroughs: () => [baseWalkthrough()] } as unknown as AiGettingStartedWalkthroughProvider;
    return new NukeAiWalkthroughProvider(base);
}

describe('NukeAiWalkthroughProvider', () => {
    it('keeps the walkthrough and step ids so progress survives', () => {
        const [walkthrough] = provider().getWalkthroughs();
        expect(walkthrough.id).toBe('ai-features.getting-started');
        expect(walkthrough.steps.map((step) => step.id)).toEqual(['ai-support', 'connect-model', 'go-further']);
    });

    it('presents the walkthrough as NukeAI with the bot icon', () => {
        const [walkthrough] = provider().getWalkthroughs();
        expect(walkthrough.title).toBe('Get started with NukeAI');
        expect(walkthrough.icon).toBe('hubot');
        expect(walkthrough.description).toContain('NukeAI');
    });

    it('replaces Theia product copy and links in the opening slide', () => {
        const step = provider().getWalkthroughs()[0].steps[0];
        expect(step.title).toContain('NukeAI');
        expect(step.description).not.toContain('Theia AI');
        expect(step.description).not.toContain('theia-ide.org');
        expect(step.description).toContain(NUKE_AI_GUIDE_LINK);
        expect(step.description).toContain('github.com/nukehub-dev/nuke-ide');
        expect(step.completionEvents).toContain(`onLink:${NUKE_AI_GUIDE_LINK}`);
    });

    it('replaces the generic documentation link in the closing slide', () => {
        const step = provider().getWalkthroughs()[0].steps[2];
        expect(step.description).toContain(NUKE_AI_GUIDE_LINK);
        expect(step.description).not.toContain('theia-ide.org');
        expect(step.description).toContain('the NukeAI guide');
    });

    it('leaves the product-neutral steps untouched', () => {
        const step = provider().getWalkthroughs()[0].steps[1];
        expect(step.title).toBe('Connect a language model');
        expect(step.description).toBe('Add an API key.');
    });
});
